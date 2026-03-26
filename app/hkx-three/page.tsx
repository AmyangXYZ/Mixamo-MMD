"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

/** Full-screen Three-only view merged into `/hkx` (side-by-side with MMD). */
export default function HkxThreeRedirect() {
	const router = useRouter()
	useEffect(() => {
		router.replace("/hkx")
	}, [router])
	return (
		<div className="fixed inset-0 flex items-center justify-center bg-[#111122] text-white/50 text-sm">
			Redirecting to combined HKX view…
		</div>
	)
}
