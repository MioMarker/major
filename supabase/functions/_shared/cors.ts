// supabase/functions/_shared/cors.ts
//
// Shared CORS headers and preflight handler for Major edge functions.
// All Major APIs accept cross-origin requests from the Next.js UI on Vercel,
// from local dev (`http://localhost:3000`), and from runners (which speak
// over plain HTTP to the function URL with a service-role token).

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-GitHub-Event, X-GitHub-Delivery, X-Hub-Signature-256",
};

// Returns a preflight response when the request is a CORS preflight,
// otherwise null so the caller can continue with the actual handler.
export function handleOptions(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  return null;
}
