"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
export function BillingSync({ pending }: { pending: boolean }) {
  const router = useRouter();
  useEffect(() => { if (!pending) return; let attempts = 0; const timer = window.setInterval(() => { router.refresh(); attempts++; if (attempts >= 6) window.clearInterval(timer); }, 5000); return () => window.clearInterval(timer); }, [pending, router]);
  return null;
}
