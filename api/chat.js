
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const token = process.env.REPLICATE_API_TOKEN;

  if (!token) {
    return res.status(500).json({
      error: "Missing REPLICATE_API_TOKEN in Vercel environment variables."
    });
  }

  try {
    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    const message = typeof body.message === "string" ? body.message : "";

    const systemPrompt =
      "You are an expert web developer. Return a complete, working, " +
      "single-file HTML document with CSS and JavaScript included. " +
      "Return HTML code only, without Markdown fences or explanations. " +
      "Implement all requested features and make the interface responsive.";

    const userPrompt = prompt || message ||
      messages.filter(m => m && m.role === "user")
        .map(m => typeof m.content === "string" ? m.content : "")
        .join("\n");

    if (!userPrompt.trim()) {
      return res.status(400).json({ error: "Please provide a coding prompt." });
    }

    const response = await fetch(
      "https://api.replicate.com/v1/models/openai/gpt-4.1-nano/predictions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "Prefer": "wait=60"
        },
        body: JSON.stringify({
          input: {
            system_prompt: systemPrompt,
            prompt: userPrompt,
            max_completion_tokens: 12000,
            temperature: 0.2
          }
        })
      }
    );

    const result = await response.json();

    if (!response.ok) {
      console.error("Replicate API error:", result);
      return res.status(response.status).json({
        error: result.detail || result.title ||
          "Replicate could not generate the code. Check your model and API token."
      });
    }

    if (result.status === "failed" || result.status === "canceled") {
      return res.status(502).json({
        error: result.error || "The code generation failed."
      });
    }

    if (result.status && result.status !== "succeeded") {
      return res.status(504).json({
        error: "Generation is still running. Please try again."
      });
    }

    const output = result.output;
    const code = Array.isArray(output)
      ? output.join("")
      : typeof output === "string" ? output : "";

    if (!code.trim()) {
      return res.status(502).json({
        error: "The model returned an empty response. Please try again."
      });
    }

    return res.status(200).json({ code });

  } catch (error) {
    console.error("Code generation error:", error);
    return res.status(500).json({
      error: "Unable to contact the AI service. Please try again."
    });
  }
}
