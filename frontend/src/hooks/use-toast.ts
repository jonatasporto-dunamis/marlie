"use client";

export type ToastOptions = {
  title?: string;
  description?: string;
  variant?: "default" | "destructive";
};

export function useToast() {
  function toast({ title, description, variant = "default" }: ToastOptions) {
    const prefix = variant === "destructive" ? "[Erro]" : "[Info]";
    if (typeof window !== "undefined") {
      // Simples feedback visual. Em produção, substitua por um sistema de toasts real.
      console[variant === "destructive" ? "error" : "log"](`${prefix} ${title ?? ""} ${description ?? ""}`);
    }
  }
  return { toast };
}