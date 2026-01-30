import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import "./globals.css"
import { Analytics } from "@vercel/analytics/next"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: "Mixamo FBX to VMD",
  description: "Convert Mixamo FBX animations to MMD VMD format",
  keywords: ["WebGPU", "3D", "MMD", "Animation", "Mixamo", "FBX", "VMD"],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark w-full m-0 p-0">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased w-full m-0 p-0`}
        style={{ backgroundColor: "black" }}
      >
        {children}
        <Analytics />
      </body>
    </html>
  )
}