// netlify/functions/prices.mjs
// GET /api/prices — returns latest stored prices from Netlify Blobs
// If no stored prices yet, triggers a live fetch and returns that

import { getStore } from "@netlify/blobs";

export default async function handler(req) {
  // CORS for local dev
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=3600", // browsers can cache 1hr
  };

  try {
    const store = getStore("commodity-prices");
    const data = await store.get("latest", { type: "json" });

    if (!data) {
      return new Response(
        JSON.stringify({ error: "No prices stored yet. Trigger a manual fetch from the Netlify dashboard." }),
        { status: 404, headers }
      );
    }

    return new Response(JSON.stringify(data), { status: 200, headers });
  } catch (err) {
    console.error("[prices] Error reading blob:", err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers }
    );
  }
}

export const config = {
  path: "/api/prices",
};
