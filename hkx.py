# HKX Tagfile parser with spline-compressed animation decompression.
#
# HKX parsing based on hkx-parser by AltimorTASDK:
#   https://github.com/AltimorTASDK/hkx-parser
#   License: MIT
#
# Spline decompression algorithm based on HavokLib by Lukas Cone (PredatorCZ):
#   https://github.com/PredatorCZ/HavokLib
#   Source: hka_spline_decompressor.cpp / .hpp
#   License: GPL-3.0

import json
import struct
import sys
from itertools import chain

def mask(value, start_bit, end_bit):
    return value & (((1 << (end_bit - start_bit + 1)) - 1) << start_bit)

def extract(value, start_bit, end_bit):
    """Mask and shift so first bit of mask is the new LSB"""
    return mask(value, start_bit, end_bit) >> start_bit

def reverse_mask64(value, start_bit, end_bit):
    """PowerPC style bit mask"""
    return mask(value, 63 - end_bit, 63 - start_bit)

def reverse_extract64(value, start_bit, end_bit):
    """PowerPC style bit mask (and shift so first bit of mask is the new LSB)"""
    return extract(value, 63 - end_bit, 63 - start_bit)

class HkxException(Exception):
    def __init__(*args, **kwargs):
        super.__init__(*args, **kwargs)

class BufferReader():
    def __init__(self, data, *, offset=0):
        self.data = data
        self.offset = offset

    def clone(self, *, offset=None):
        if offset is None:
            return BufferReader(self.data, offset=self.offset)
        else:
            return BufferReader(self.data, offset=offset)

    def eof(self):
        return self.offset >= len(self.data)

    def unpack(self, format, *, peek=False, offset=0):
        # Allow partial overread for varint decoding
        start = self.offset + offset
        if start >= len(self.data):
            raise IndexError
        end = start + struct.calcsize(format)
        buffer = self.data[start:end].ljust(end - start, b'\x00')

        result = struct.unpack(format, buffer)
        if not peek:
            self.offset = end
        return result

    def read(self, count, *, peek=False, offset=0):
        result = self.data[self.offset+offset:self.offset+offset+count]
        if not peek:
            self.offset += count + offset
        return result

    def tell(self):
        return self.offset

    def seek(self, offset):
        self.offset = offset

    def skip(self, count):
        self.offset += count

class IndentPrint():
    level = -1
    @staticmethod
    def print(*args, **kwargs):
        pass

class Section():
    def __init__(self, flags, size, tag):
        self.tag = tag
        self.flags = flags
        self.total_size = size
        self.data_size = size - 8

class Field():
    def __init__(self, name, flags, offset, type):
        self.name = name
        self.flags = flags
        self.offset = offset
        self.type = type

class Interface():
    def __init__(self, type, name, flags=0):
        self.type = type
        self.name = name

class TemplateParam():
    def __init__(self, name, value):
        self.name = name
        self.value = value

    def is_type(self):
        return self.name[0] == 't'

class Type():
    def __init__(self):
        self.name       = None
        self.template   = None
        self.parent     = None
        self.opts       = 0
        self.format     = None
        self.subtype    = None
        self.version    = None
        self.size       = None
        self.align      = None
        self.flags      = None
        self.fields     = []
        self.interfaces = []
        self.attribute  = None

    def hierarchy(self):
        typ = self
        types = []
        while typ is not None:
            types.append(typ)
            typ = typ.parent
        return reversed(types)

    def all_fields(self):
        return chain(*[t.fields for t in self.hierarchy()])

    def is_pointer(self):
        return self.name == "T*"

    def is_array(self):
        return self.name == "T[N]"

    def resolve(self):
        """Resolve type aliases like hkInt32"""
        typ = self
        while typ.format is None and typ.parent is not None:
            typ = typ.parent
        return typ

    def get_name(self):
        template = self.template

        if len(template) == 0:
            return self.name

        if self.is_pointer():
            return f"{template[0].value.get_name()}*"
        if self.is_array():
            return (f"{template[0].value.get_name()}"
                    f"[{template[1].value}]")

        params = []

        for param in template:
            if param.is_type():
                params.append(param.value.get_name())
            else:
                params.append(f"{param.value}")

        return f"{self.name}<{', '.join(params)}>"

    def get_format_type(self):
        return self.format & 31

class Item():
    def __init__(self, type, flags, offset, count):
        self.type = type
        self.flags = flags
        self.offset = offset
        self.count = count
        self.value = None

    def is_pointer(self):
        return (self.flags & ItemFlag.POINTER) != 0

    def is_array(self):
        return (self.flags & ItemFlag.ARRAY) != 0

def read_string(reader):
    result = b""
    while not reader.eof():
        c = reader.read(1)
        if c == b'\x00':
            break
        result += c
    return result.decode()

def read_string_section(reader):
    strings = []
    while not reader.eof():
        strings.append(read_string(reader))
    return strings

def decode_varint(reader):
    """Returns tuple of size and value"""
    value, = reader.unpack(">Q", peek=True)
    msb = reverse_extract64(value, 0, 7)
    mode = msb >> 3

    if mode <= 15:
        return (1, msb)
    if mode <= 23:
        return (2, reverse_extract64(value, 2, 16 - 1))
    if mode <= 27:
        return (3, reverse_extract64(value, 3, 24 - 1))
    if mode == 28:
        return (4, reverse_extract64(value, 5, 32 - 1))
    if mode == 29:
        return (5, reverse_extract64(value, 5, 40 - 1))
    if mode == 30:
        return (8, reverse_extract64(value, 5, 64 - 1))
    if mode == 31 and (msb & 7) == 0:
        return (6, reverse_extract64(value, 8, 48 - 1))
    if mode == 31 and (msb & 7) == 1:
        return (9, reader.unpack(">Q", peek=True, offset=1)[0])

    raise HkxException(f"Bad varint encoding mode {msb:02X}")

def read_varint(reader, max_bits=None):
    size, value = decode_varint(reader)
    reader.skip(size)
    if max_bits is not None and (value >> max_bits) != 0:
        raise HkxException(f"varint is too large: {value:X}, bits {max_bits}")
    return value

def read_varint_u16(reader):
    return read_varint(reader, 16)

def read_varint_s32(reader):
    return read_varint(reader, 31)

def read_varint_u32(reader):
    return read_varint(reader, 32)

class Opt():
    FORMAT     = 0x00000001
    SUBTYPE    = 0x00000002
    VERSION    = 0x00000010
    INTERFACES = 0x00020000
    SIZE_ALIGN = 0x00800000
    FLAGS      = 0x01000000
    FIELDS     = 0x04000000
    ATTRIBUTE  = 0x10000000

class FormatType():
    VOID    = 0
    OPAQUE  = 1
    BOOL    = 2
    STRING  = 3
    INT     = 4
    FLOAT   = 5
    POINTER = 6
    RECORD  = 7
    ARRAY   = 8

class FormatFlag():
    INLINE_ARRAY = 0x00000020
    SIGNED       = 0x00000200
    INT8         = 0x00002000
    INT16        = 0x00004000
    INT32        = 0x00008000
    INT64        = 0x00010000

class ItemFlag():
    POINTER = 0x10
    ARRAY   = 0x20

def read_opts(reader):
    FLAGS = [
        Opt.FORMAT,
        Opt.SUBTYPE,
        Opt.VERSION,
        Opt.SIZE_ALIGN,
        Opt.FLAGS,
        Opt.FIELDS,
        Opt.INTERFACES,
        Opt.ATTRIBUTE
    ]
    value = read_varint_u32(reader)
    return sum(flag for i, flag in enumerate(FLAGS) if value & (1 << i))

def read_section(reader):
    size_and_flags, tag = reader.unpack(">I4s")
    flags = size_and_flags >> 30
    size = size_and_flags & ((1 << 30) - 1)
    return Section(flags, size, tag.decode())

def read_sections(reader, section_handlers):
    IndentPrint.level += 1

    while not reader.eof():
        header = read_section(reader)
        if header.tag in section_handlers:
            section_handlers[header.tag](reader, header)
        else:
            IndentPrint.print(header.tag)
            reader.skip(header.data_size)

    IndentPrint.level -= 1

class HkxParser():
    def __init__(self):
        self.data = None
        self.tstr = None
        self.fstr = None
        self.types = None
        self.items = None

    def TAG0(self, reader, header):
        read_sections(BufferReader(reader.read(header.data_size)), {
            'DATA': self.DATA,
            'INDX': self.INDX,
            'SDKV': self.SDKV,
            'TYPE': self.TYPE,
        })

    def DATA(self, reader, header):
        IndentPrint.print("DATA")
        self.data = BufferReader(reader.read(header.data_size))

    def INDX(self, reader, header):
        IndentPrint.print("INDX")
        read_sections(BufferReader(reader.read(header.data_size)), {
            'ITEM': self.ITEM
        })

    def ITEM(self, reader, header):
        IndentPrint.print("ITEM")
        inner = BufferReader(reader.read(header.data_size))
        IndentPrint.level += 1
        self.items = []
        while not inner.eof():
            self.items.append(self.read_item(inner))
        IndentPrint.level -= 1

    def SDKV(self, reader, header):
        IndentPrint.print(f"SDKV: {reader.read(header.data_size).decode()}")

    def TYPE(self, reader, header):
        IndentPrint.print("TYPE")
        read_sections(BufferReader(reader.read(header.data_size)), {
            'TSTR': self.TSTR,
            'TNA1': self.TNA1,
            'FSTR': self.FSTR,
            'TBDY': self.TBDY
        })

    def TSTR(self, reader, header):
        IndentPrint.print("TSTR")
        if self.tstr is not None:
            raise HkxException("Found multiple TSTR sections")
        inner = BufferReader(reader.read(header.data_size))
        self.tstr = read_string_section(inner)

    def TNA1(self, reader, header):
        IndentPrint.print("TNA1")
        if self.types is not None:
            raise HkxException("Found multiple TNA1 sections")
        inner = BufferReader(reader.read(header.data_size))
        count = read_varint_s32(inner)
        IndentPrint.level += 1
        self.types = [None] + [Type() for _ in range(1, count)]
        for i in range(1, count):
            self.read_type_identity(inner, self.types[i])
        IndentPrint.level -= 1

    def FSTR(self, reader, header):
        IndentPrint.print("FSTR")
        if self.fstr is not None:
            raise HkxException("Found multiple FSTR sections")
        inner = BufferReader(reader.read(header.data_size))
        self.fstr = read_string_section(inner)

    def TBDY(self, reader, header):
        IndentPrint.print("TBDY")
        inner = BufferReader(reader.read(header.data_size))
        IndentPrint.level += 1
        while not inner.eof():
            self.read_type_body(inner)
        IndentPrint.level -= 1

    def read_type_identity(self, reader, typ):
        typ.name        = self.tstr[read_varint_s32(reader)]
        typ.template    = []
        for _ in range(read_varint_s32(reader)):
            param_name = self.tstr[read_varint_s32(reader)]
            if param_name[0] == 't':
                param_value = self.types[read_varint_s32(reader)]
            else:
                param_value = read_varint_s32(reader)
            typ.template.append(TemplateParam(param_name, param_value))

    def read_type_body(self, reader):
        id = read_varint_s32(reader)
        if id == 0:
            return

        typ = self.types[id]
        typ.parent = self.types[read_varint_s32(reader)]
        typ.opts = read_opts(reader)

        if typ.opts & Opt.FORMAT:
            typ.format = read_varint_u32(reader)
        if typ.opts & Opt.SUBTYPE:
            if typ.format == 0:
                raise HkxException("Invalid type with Opt::SUBTYPE optional "
                                   "but no Opt::FORMAT.")
            typ.subtype = self.types[read_varint_s32(reader)]
        if typ.opts & Opt.VERSION:
            typ.version = read_varint_s32(reader)
        if typ.opts & Opt.SIZE_ALIGN:
            typ.size  = read_varint_u32(reader)
            typ.align = read_varint_u32(reader)
        if typ.opts & Opt.FLAGS:
            typ.flags = read_varint_u16(reader)
        if typ.opts & Opt.FIELDS:
            field_count_pair  = read_varint_s32(reader)
            field_count       = extract(field_count_pair, 0, 15)
            placeholder_count = extract(field_count_pair, 16, 31)
            for _ in range(field_count):
                field_name   = self.fstr[read_varint_u16(reader)]
                field_flags  = read_varint_u16(reader)
                field_offset = read_varint_u16(reader)
                field_type   = self.types[read_varint_s32(reader)]
                typ.fields.append(Field(field_name, field_flags, field_offset,
                                        field_type))
        if typ.opts & Opt.INTERFACES:
            interface_count = read_varint_s32(reader)
            for _ in range(interface_count):
                interface_type = self.types[read_varint_s32(reader)]
                interface_name = self.fstr[read_varint_s32(reader)]
                typ.interfaces.append(Interface(interface_type, interface_name))
        if typ.opts & Opt.ATTRIBUTE:
            typ.attribute = read_varint_s32(reader)

        IndentPrint.print(f"type body {id}: {typ.get_name()}")
        IndentPrint.level += 1

        if typ.parent is not None:
            IndentPrint.print(f"parent    {typ.parent.get_name()}")
        IndentPrint.print(f"opts      {typ.opts:08X}")
        if typ.format is not None:
            IndentPrint.print(f"format    {typ.format:08X} "
                                       f"({typ.get_format_type()})")
        if typ.subtype is not None:
            IndentPrint.print(f"subtype   {typ.subtype.get_name()}")
        if typ.version is not None:
            IndentPrint.print(f"version   {typ.version}")
        if typ.flags is not None:
            IndentPrint.print(f"flags     {typ.flags:02X}")
        if typ.size is not None:
            IndentPrint.print(f"size      {typ.size}")
            IndentPrint.print(f"align     {typ.align}")
        if typ.attribute is not None:
            IndentPrint.print(f"attribute {typ.attribute}")
        if len(typ.fields) != 0:
            IndentPrint.print("fields")
            IndentPrint.level += 1
            for field in typ.fields:
                IndentPrint.print(f"{field.offset:02X}: "
                                  f"{field.type.get_name()} {field.name}")
            IndentPrint.level -= 1
        if len(typ.interfaces) != 0:
            IndentPrint.print("interfaces")
            IndentPrint.level += 1
            for iface in typ.interfaces:
                if iface.name is not None:
                    IndentPrint.print(f"{iface.type.get_name()} {iface.name}")
            IndentPrint.level -= 1

        IndentPrint.level -= 1

    def read_item(self, reader):
        type_and_flags, offset, count = reader.unpack("<III")
        type_id = extract(type_and_flags, 0, 23)
        flags   = extract(type_and_flags, 24, 31)
        if type_id == 0:
            return None
        typ = self.types[type_id]
        IndentPrint.print("item")
        IndentPrint.level += 1
        IndentPrint.print(f"type   {typ.get_name()}")
        IndentPrint.print(f"flags  {flags:02X}")
        IndentPrint.print(f"offset {offset:08X}")
        IndentPrint.print(f"count  {count}")
        IndentPrint.level -= 1
        return Item(typ, flags, offset, count)

    def read_pointer(self, reader):
        return self.items[reader.unpack("<Q")[0]]

    def deserialize_item(self, reader, item):
        if item is None:
            return None
        if item.value is None:
            item_reader = reader.clone(offset=item.offset)
            if item.is_array():
                item.value = [self.deserialize_object(item_reader, item.type)
                                                for _ in range(item.count)]
            else:
                item.value = self.deserialize_object(item_reader, item.type)
        # Return cached value
        return item.value

    def deserialize_string(self, reader, item):
        if item is None:
            return None
        if not item.is_array():
            raise HkxException("Unexpected non-array")
        return reader.clone(offset=item.offset).read(item.count - 1).decode()

    def deserialize_object_impl(self, reader, typ, name):
        fmt = typ.format
        fmt_type = typ.get_format_type()

        if fmt_type == FormatType.BOOL:
            return reader.unpack("?")[0]

        if fmt_type == FormatType.STRING:
            return self.deserialize_string(reader, self.read_pointer(reader))

        if fmt_type == FormatType.INT:
            if fmt & FormatFlag.INT8:
                if fmt & FormatFlag.SIGNED:
                    return reader.unpack("<b")[0]
                else:
                    return reader.unpack("<B")[0]
            if fmt & FormatFlag.INT16:
                if fmt & FormatFlag.SIGNED:
                    return reader.unpack("<h")[0]
                else:
                    return reader.unpack("<H")[0]
            if fmt & FormatFlag.INT32:
                if fmt & FormatFlag.SIGNED:
                    return reader.unpack("<i")[0]
                else:
                    return reader.unpack("<I")[0]
            if fmt & FormatFlag.INT64:
                if fmt & FormatFlag.SIGNED:
                    return reader.unpack("<q")[0]
                else:
                    return reader.unpack("<Q")[0]
            raise NotImplementedError

        if fmt_type == FormatType.FLOAT:
            return reader.unpack("<f")[0]

        if fmt_type == FormatType.ARRAY and fmt & FormatFlag.INLINE_ARRAY:
            offset = reader.tell()
            result = []
            while reader.tell() < offset + typ.size:
                result.append(self.deserialize_object(reader, typ.subtype))
            return result

        if fmt_type in [FormatType.POINTER, FormatType.ARRAY]:
            item = self.read_pointer(reader)
            if item is not None and typ.subtype not in item.type.hierarchy():
                if typ.subtype.get_format_type() != FormatType.OPAQUE:
                    raise HkxException("Unexpected pointer type")
            return self.deserialize_item(reader, item)

        if fmt_type == FormatType.RECORD:
            offset = reader.tell()
            result = {}
            for f in typ.all_fields():
                reader.seek(offset + f.offset)
                result[f.name] = self.deserialize_object(reader, f.type, f.name)
            return result

        print(f"Unimplemented format type {fmt_type}")
        raise NotImplementedError

    def deserialize_object(self, reader, typ, name=None):
        real_typ = typ.resolve()
        offset = reader.tell()
        if real_typ.align is not None:
            offset = (offset + real_typ.align - 1) & ~(real_typ.align - 1)
            reader.seek(offset)
        value = self.deserialize_object_impl(reader, real_typ, name)
        if real_typ.size is not None:
            reader.seek(offset + real_typ.size)
        return value

import math

# ── Spline decompression ────────────────────────────────────────────
# Reference: PredatorCZ/HavokLib hka_spline_decompressor.cpp/.hpp

STT_DYNAMIC  = 0
STT_STATIC   = 1
STT_IDENTITY = 2

QT_8bit  = 0
QT_16bit = 1
QT_32bit = 2
QT_40bit = 3
QT_48bit = 4
QT_24bit = 5
QT_16bitQuat = 6
QT_UNCOMPRESSED = 7

def parse_transform_mask(b):
    """Parse 4-byte TransformMask: quantTypes, posFlags, rotFlags, scaleFlags"""
    quant = b[0]
    pos_flags = b[1]
    rot_flags = b[2]
    scale_flags = b[3]
    return quant, pos_flags, rot_flags, scale_flags

def get_pos_quant(quant): return quant & 3
def get_rot_quant(quant): return ((quant >> 2) & 0xF) + 2
def get_scale_quant(quant): return (quant >> 6) & 3

def get_vec_sub_track(flags, axis):
    """axis: 0=X, 1=Y, 2=Z. flags byte: bits 0-3=static XYZW, bits 4-7=spline XYZW"""
    static_bit = 1 << axis
    spline_bit = 1 << (axis + 4)
    if flags & static_bit: return STT_STATIC
    if flags & spline_bit: return STT_DYNAMIC
    return STT_IDENTITY

def get_rot_sub_track(rot_flags):
    if rot_flags & 0xF0: return STT_DYNAMIC
    if rot_flags & 0x0F: return STT_STATIC
    return STT_IDENTITY

def align_offset(offset, alignment=4):
    r = offset % alignment
    return offset + (alignment - r) if r else offset

def read_f32(data, off):
    return struct.unpack_from('<f', data, off)[0]

def read_u8(data, off):
    return data[off]

def read_u16(data, off):
    return struct.unpack_from('<H', data, off)[0]

def read_u32(data, off):
    return struct.unpack_from('<I', data, off)[0]

def read_quat_32bit(data, off):
    cval = read_u32(data, off)
    r_mask = (1 << 10) - 1
    r_frac = 1.0 / r_mask
    phi_frac = (math.pi * 0.5) / 511.0

    R = float((cval >> 18) & r_mask) * r_frac
    R = 1.0 - R * R

    phi_theta = float(cval & 0x3FFFF)
    phi = math.floor(math.sqrt(phi_theta))
    theta = 0.0
    if phi > 0.0:
        theta = (math.pi * 0.25) * (phi_theta - phi * phi) / phi
        phi = phi_frac * phi

    magnitude = math.sqrt(max(0, 1.0 - R * R))
    sp, cp = math.sin(phi), math.cos(phi)
    st, ct = math.sin(theta), math.cos(theta)
    x = sp * ct * magnitude
    y = sp * st * magnitude
    z = cp * magnitude
    w = R

    if cval & 0x10000000: x = -x
    if cval & 0x20000000: y = -y
    if cval & 0x40000000: z = -z
    if cval & 0x80000000: w = -w
    return (x, y, z, w), off + 4

def read_quat_40bit(data, off):
    # THREECOMP40: 12 bits per component, reconstructs dropped quaternion element
    mask12 = (1 << 12) - 1
    half = mask12 >> 1          # 2047
    fractal = 0.000345436
    cval = int.from_bytes(data[off:off+5], 'little')

    x = (cval & mask12) - half
    y = ((cval >> 12) & mask12) - half
    z = ((cval >> 24) & mask12) - half
    shift = (cval >> 36) & 3

    fv = [x * fractal, y * fractal, z * fractal]
    retval = [0.0, 0.0, 0.0, 0.0]
    for i in range(4):
        if i < shift:   retval[i] = fv[i]
        elif i > shift:  retval[i] = fv[i - 1]

    sq = fv[0]*fv[0] + fv[1]*fv[1] + fv[2]*fv[2]
    retval[shift] = math.sqrt(max(0, 1.0 - sq))
    if (cval >> 38) & 1:
        retval[shift] = -retval[shift]

    return tuple(retval), off + 5

def read_quat_48bit(data, off):
    mask = (1 << 15) - 1
    fractal = 0.000043161
    s0 = struct.unpack_from('<HHH', data, off)

    shift = ((s0[1] >> 14) & 2) | ((s0[0] >> 15) & 1)
    r_sign = (s0[2] >> 15) != 0

    fv = [(float((s0[i] & mask) - (mask >> 1)) * fractal) for i in range(3)]
    sq = fv[0]*fv[0] + fv[1]*fv[1] + fv[2]*fv[2]
    fv.append(math.sqrt(max(0, 1.0 - sq)))
    if r_sign: fv[3] = -fv[3]

    if shift == 0:   r = [fv[3], fv[0], fv[1], fv[2]]
    elif shift == 1:  r = [fv[0], fv[3], fv[1], fv[2]]
    elif shift == 2:  r = [fv[0], fv[1], fv[3], fv[2]]
    else:             r = fv
    return tuple(r), off + 6

def read_quat(qtype, data, off):
    if qtype == QT_32bit:    return read_quat_32bit(data, off)
    if qtype == QT_40bit:    return read_quat_40bit(data, off)
    if qtype == QT_48bit:    return read_quat_48bit(data, off)
    if qtype == QT_UNCOMPRESSED:
        x, y, z, w = struct.unpack_from('<ffff', data, off)
        return (x, y, z, w), off + 16
    return (0.0, 0.0, 0.0, 1.0), off

# B-spline evaluation (The NURBS Book, Algorithm A2.1 + TIME-EFFICIENT method)
def find_knot_span(degree, value, n_cpoints, knots):
    if value >= knots[n_cpoints]:
        return n_cpoints - 1
    low, high = degree, n_cpoints
    mid = (low + high) // 2
    while value < knots[mid] or value >= knots[mid + 1]:
        if value < knots[mid]: high = mid
        else: low = mid
        mid = (low + high) // 2
    return mid

def eval_spline_scalar(knot_span, degree, frame, knots, cpoints):
    N = [0.0] * (degree + 1)
    N[0] = 1.0
    for i in range(1, degree + 1):
        for j in range(i - 1, -1, -1):
            denom = knots[knot_span + i - j] - knots[knot_span - j]
            A = (frame - knots[knot_span - j]) / denom if denom != 0 else 0
            tmp = N[j] * A
            N[j + 1] += N[j] - tmp
            N[j] = tmp
    result = 0.0
    for i in range(degree + 1):
        result += cpoints[knot_span - i] * N[i]
    return result

def eval_spline_quat(knot_span, degree, frame, knots, cpoints):
    N = [0.0] * (degree + 1)
    N[0] = 1.0
    for i in range(1, degree + 1):
        for j in range(i - 1, -1, -1):
            denom = knots[knot_span + i - j] - knots[knot_span - j]
            A = (frame - knots[knot_span - j]) / denom if denom != 0 else 0
            tmp = N[j] * A
            N[j + 1] += N[j] - tmp
            N[j] = tmp
    rx, ry, rz, rw = 0.0, 0.0, 0.0, 0.0
    for i in range(degree + 1):
        q = cpoints[knot_span - i]
        rx += q[0] * N[i]; ry += q[1] * N[i]
        rz += q[2] * N[i]; rw += q[3] * N[i]
    ln = math.sqrt(rx*rx + ry*ry + rz*rz + rw*rw)
    if ln > 1e-10: rx /= ln; ry /= ln; rz /= ln; rw /= ln
    return (rx, ry, rz, rw)

def decompress_spline_animation(anim):
    """Decompress hkaSplineCompressedAnimation, returns per-frame transforms."""
    num_tracks = anim['numberOfTransformTracks']
    num_floats = anim.get('numberOfFloatTracks', 0)
    num_frames = anim['numFrames']
    num_blocks = anim['numBlocks']
    duration = anim['duration']
    frame_duration = anim['frameDuration']
    block_duration = anim['blockDuration']
    block_offsets = anim['blockOffsets']
    max_frames_per_block = anim.get('maxFramesPerBlock', 256)
    raw = bytes(anim['data'])

    all_frames = []

    for block_idx in range(num_blocks):
        block_start = block_offsets[block_idx]
        off = block_start

        # how many frames in this block
        frames_in_block = min(num_frames - block_idx * max_frames_per_block,
                              max_frames_per_block)

        # Parse transform masks (4 bytes each)
        masks = []
        for t in range(num_tracks):
            masks.append(raw[off:off+4])
            off += 4
        # skip float track masks
        off += num_floats
        off = align_offset(off)

        # Per-track: parse spline header data
        track_data = []
        for t in range(num_tracks):
            quant, pos_flags, rot_flags, scale_flags = parse_transform_mask(masks[t])
            td = {}

            # ── Position ──
            pos_quant = get_pos_quant(quant)
            pos_stt = [get_vec_sub_track(pos_flags, a) for a in range(3)]
            any_pos_dynamic = any(s == STT_DYNAMIC for s in pos_stt)

            if any_pos_dynamic:
                num_items = read_u16(raw, off); off += 2
                degree = read_u8(raw, off); off += 1
                knot_count = num_items + degree + 2
                knots = [float(raw[off + i]) for i in range(knot_count)]
                off += knot_count
                off = align_offset(off)

                extremes = [None, None, None]
                for a in range(3):
                    if pos_stt[a] == STT_DYNAMIC:
                        mn = read_f32(raw, off); mx = read_f32(raw, off + 4)
                        extremes[a] = (mn, mx); off += 8
                    elif pos_stt[a] == STT_STATIC:
                        td[f'pos_static_{a}'] = read_f32(raw, off); off += 4

                # read quantized control points
                cpoints = [[] for _ in range(3)]
                for i in range(num_items + 1):
                    for a in range(3):
                        if pos_stt[a] == STT_DYNAMIC:
                            if pos_quant == QT_8bit:
                                v = read_u8(raw, off); off += 1
                                mn, mx = extremes[a]
                                cpoints[a].append(mn + (mx - mn) * (v / 255.0))
                            else:
                                v = read_u16(raw, off); off += 2
                                mn, mx = extremes[a]
                                cpoints[a].append(mn + (mx - mn) * (v / 65535.0))
                off = align_offset(off)
                td['pos'] = {'type': 'spline', 'degree': degree, 'knots': knots,
                             'cpoints': cpoints, 'stt': pos_stt,
                             'num_items': num_items}
            else:
                static_pos = [0.0, 0.0, 0.0]
                for a in range(3):
                    if pos_stt[a] == STT_STATIC:
                        static_pos[a] = read_f32(raw, off); off += 4
                td['pos'] = {'type': 'static', 'value': static_pos, 'stt': pos_stt}

            off = align_offset(off)
            # ── Rotation ──
            rot_quant = get_rot_quant(quant)
            rot_stt = get_rot_sub_track(rot_flags)
            if rot_stt == STT_DYNAMIC:
                num_items = read_u16(raw, off); off += 2
                degree = read_u8(raw, off); off += 1
                knot_count = num_items + degree + 2
                knots_r = [float(raw[off + i]) for i in range(knot_count)]
                off += knot_count
                if rot_quant in (QT_48bit, QT_16bitQuat):
                    off = align_offset(off, 2)
                elif rot_quant in (QT_32bit, QT_UNCOMPRESSED):
                    off = align_offset(off, 4)
                quat_cpoints = []
                for i in range(num_items + 1):
                    q, off = read_quat(rot_quant, raw, off)
                    quat_cpoints.append(q)
                td['rot'] = {'type': 'spline', 'degree': degree, 'knots': knots_r,
                             'cpoints': quat_cpoints, 'num_items': num_items}
            elif rot_stt == STT_STATIC:
                # align before reading static quaternion (matches DSAnimStudio)
                rot_align = {QT_32bit: 4, QT_40bit: 1, QT_48bit: 2,
                             QT_24bit: 1, QT_16bitQuat: 2, QT_UNCOMPRESSED: 4}.get(rot_quant, 4)
                if rot_align > 1:
                    off = align_offset(off, rot_align)
                q, off = read_quat(rot_quant, raw, off)
                td['rot'] = {'type': 'static', 'value': q}
            else:
                td['rot'] = {'type': 'identity', 'value': (0, 0, 0, 1)}

            off = align_offset(off)

            # ── Scale ──
            scale_quant = get_scale_quant(quant)
            scale_stt = [get_vec_sub_track(scale_flags, a) for a in range(3)]
            any_scale_dynamic = any(s == STT_DYNAMIC for s in scale_stt)

            if any_scale_dynamic:
                num_items = read_u16(raw, off); off += 2
                degree = read_u8(raw, off); off += 1
                knot_count = num_items + degree + 2
                knots_s = [float(raw[off + i]) for i in range(knot_count)]
                off += knot_count
                off = align_offset(off)

                extremes_s = [None, None, None]
                for a in range(3):
                    if scale_stt[a] == STT_DYNAMIC:
                        mn = read_f32(raw, off); mx = read_f32(raw, off + 4)
                        extremes_s[a] = (mn, mx); off += 8
                    elif scale_stt[a] == STT_STATIC:
                        td[f'scale_static_{a}'] = read_f32(raw, off); off += 4

                cpoints_s = [[] for _ in range(3)]
                for i in range(num_items + 1):
                    for a in range(3):
                        if scale_stt[a] == STT_DYNAMIC:
                            if scale_quant == QT_8bit:
                                v = read_u8(raw, off); off += 1
                                mn, mx = extremes_s[a]
                                cpoints_s[a].append(mn + (mx - mn) * (v / 255.0))
                            else:
                                v = read_u16(raw, off); off += 2
                                mn, mx = extremes_s[a]
                                cpoints_s[a].append(mn + (mx - mn) * (v / 65535.0))
                off = align_offset(off)
                td['scale'] = {'type': 'spline', 'degree': degree, 'knots': knots_s,
                               'cpoints': cpoints_s, 'stt': scale_stt,
                               'num_items': num_items}
            else:
                static_scale = [1.0, 1.0, 1.0]
                for a in range(3):
                    if scale_stt[a] == STT_STATIC:
                        static_scale[a] = read_f32(raw, off); off += 4
                td['scale'] = {'type': 'static', 'value': static_scale, 'stt': scale_stt}

            off = align_offset(off)
            track_data.append(td)

        off = align_offset(off, 16)
        # ── Evaluate at each frame ──
        block_time_start = block_idx * block_duration
        for frame_idx in range(frames_in_block):
            local_frame = float(frame_idx)
            frame_transforms = []
            for t in range(num_tracks):
                td = track_data[t]

                # Position
                p = td['pos']
                if p['type'] == 'spline':
                    px, py, pz = 0.0, 0.0, 0.0
                    for a in range(3):
                        if p['stt'][a] == STT_DYNAMIC:
                            n_cp = len(p['cpoints'][a])
                            if n_cp == 1:
                                val = p['cpoints'][a][0]
                            else:
                                ks = find_knot_span(p['degree'], local_frame,
                                                    n_cp, p['knots'])
                                val = eval_spline_scalar(ks, p['degree'],
                                                         local_frame, p['knots'],
                                                         p['cpoints'][a])
                            [px, py, pz][a]  # dummy
                            if a == 0: px = val
                            elif a == 1: py = val
                            else: pz = val
                        elif p['stt'][a] == STT_STATIC:
                            key = f'pos_static_{a}'
                            val = td.get(key, 0.0)
                            if a == 0: px = val
                            elif a == 1: py = val
                            else: pz = val
                    pos = [px, py, pz]
                else:
                    pos = list(p['value'])

                # Rotation
                r = td['rot']
                if r['type'] == 'spline':
                    n_cp = len(r['cpoints'])
                    if n_cp == 1:
                        rot = list(r['cpoints'][0])
                    else:
                        ks = find_knot_span(r['degree'], local_frame,
                                            n_cp, r['knots'])
                        rot = list(eval_spline_quat(ks, r['degree'],
                                                     local_frame, r['knots'],
                                                     r['cpoints']))
                else:
                    rot = list(r['value'])

                # Scale
                s = td['scale']
                if s['type'] == 'spline':
                    sx, sy, sz = 1.0, 1.0, 1.0
                    for a in range(3):
                        if s['stt'][a] == STT_DYNAMIC:
                            n_cp = len(s['cpoints'][a])
                            if n_cp == 1:
                                val = s['cpoints'][a][0]
                            else:
                                ks = find_knot_span(s['degree'], local_frame,
                                                    n_cp, s['knots'])
                                val = eval_spline_scalar(ks, s['degree'],
                                                         local_frame, s['knots'],
                                                         s['cpoints'][a])
                            if a == 0: sx = val
                            elif a == 1: sy = val
                            else: sz = val
                        elif s['stt'][a] == STT_STATIC:
                            key = f'scale_static_{a}'
                            val = td.get(key, 1.0)
                            if a == 0: sx = val
                            elif a == 1: sy = val
                            else: sz = val
                    scale = [sx, sy, sz]
                else:
                    scale = list(s['value'])

                frame_transforms.append({
                    'translation': pos,
                    'rotation': rot,
                    'scale': scale
                })
            all_frames.append(frame_transforms)

    return all_frames


def find_animation_container(value):
    for nv in value.get('namedVariants', []):
        v = nv.get('variant', {})
        if isinstance(v, dict) and ('animations' in v or 'skeletons' in v):
            return v
    return None


def main():
    if len(sys.argv) < 3:
        print("Usage: hkx.py <input.hkx> <output.json>", file=sys.stderr)
        sys.exit(1)

    with open(sys.argv[1], "rb") as f:
        data = f.read()

    hkx = HkxParser()
    read_sections(BufferReader(data), {'TAG0': hkx.TAG0})
    value = hkx.deserialize_item(hkx.data, hkx.items[1])

    container = find_animation_container(value)
    if not container:
        print(f"ERROR: No animation container found in {sys.argv[1]}", file=sys.stderr)
        sys.exit(1)

    skeletons = container.get('skeletons') or []
    animations = container.get('animations') or []
    bindings = container.get('bindings') or []

    if not skeletons:
        print(f"WARNING: No skeleton in {sys.argv[1]}, animation-only file", file=sys.stderr)

    if not animations:
        print(f"WARNING: No animations in {sys.argv[1]}", file=sys.stderr)

    # Decompress spline-compressed animations
    for anim in animations:
        if anim.get('type') == 3 and 'data' in anim:
            frames = decompress_spline_animation(anim)
            anim['frames'] = frames
            anim['numDecompressedFrames'] = len(frames)
            del anim['data']

    # Same for animations inlined inside bindings
    for bind in bindings:
        ba = bind.get('animation')
        if ba and ba.get('type') == 3 and 'data' in ba and 'frames' not in ba:
            frames = decompress_spline_animation(ba)
            ba['frames'] = frames
            ba['numDecompressedFrames'] = len(frames)
            del ba['data']

    with open(sys.argv[2], "w") as f:
        json.dump(value, f, indent=4)

    # Print summary
    print(f"Input:  {sys.argv[1]}")
    print(f"Output: {sys.argv[2]}")

    for si, skel in enumerate(skeletons):
        bones = skel.get('bones', [])
        refs = skel.get('referencePose', [])
        print(f"Skeleton[{si}]: \"{skel.get('name', '?')}\" — {len(bones)} bones, {len(refs)} refPose entries")

    for ai, anim in enumerate(animations):
        n_tracks = anim.get('numberOfTransformTracks', 0)
        n_frames = anim.get('numDecompressedFrames', 0)
        duration = anim.get('duration', 0)
        fps = round(n_frames / duration) if duration > 0 and n_frames > 1 else 0
        print(f"Animation[{ai}]: {duration:.3f}s, {n_frames} frames (~{fps}fps), {n_tracks} tracks")

        # Per-track frame counts (translation/rotation/scale may differ due to static vs spline)
        frames = anim.get('frames', [])
        if frames and skeletons:
            bone_names = [b['name'] for b in skeletons[0].get('bones', [])]
            static_t, static_r, static_s = 0, 0, 0
            for ti in range(min(n_tracks, len(bone_names))):
                has_t = any(f[ti].get('translation') is not None for f in frames)
                has_r = any(f[ti].get('rotation') is not None for f in frames)
                has_s = any(f[ti].get('scale') is not None for f in frames)
                if not has_t: static_t += 1
                if not has_r: static_r += 1
                if not has_s: static_s += 1
            animated = n_tracks - max(static_t, static_r)
            print(f"  Animated tracks: {animated}/{n_tracks} "
                  f"(static: {static_t}T {static_r}R {static_s}S)")

if __name__ == "__main__":
    main()