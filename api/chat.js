export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST to generate code." });
  }

  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    return res.status(500).json({
      error: "REPLICATE_API_TOKEN is missing from Vercel Environment Variables."
    });
  }

  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  if (!prompt) {
    return res.status(400).json({ error: "Please describe the app you want to build." });
  }

  const systemPrompt = `
You are Code Studio, an expert web developer.
Understand ordinary, simple user requests without requiring technical prompts.
For "a docs app in which I can just write", create a usable document editor
with editable writing area, create document, rename, delete, automatic local
saving and reopening documents.
Return a complete standalone HTML document including CSS and JavaScript.
Implement real functionality, polished design, and responsive layout.
Return HTML source only. Do not use Markdown fences or explanations.
Do not omit code or use placeholders.
`.trim();

  let predictionId = null;
  let streamUrl = null;

  try {
    const createResponse = await fetch(
      "https://api.replicate.com/v1/models/openai/gpt-4.1-nano/predictions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          stream: true,
          input: {
            system_prompt: systemPrompt,
            prompt,
            max_completion_tokens: 12000,
            temperature: 0.2
          }
        })
      }
    );

    const prediction = await createResponse.json().catch(() => ({}));

    if (!createResponse.ok) {
      console.error("Replicate create error:", prediction);
      return res.status(createResponse.status).json({
        error: prediction.detail || prediction.error || prediction.title ||
          "Replicate could not start generation."
      });
    }

    predictionId = prediction.id;
    streamUrl = prediction.urls?.stream;

    if (!streamUrl) {
      console.error("Missing Replicate stream URL:", prediction);
      return res.status(502).json({
        error: "Replicate did not provide a stream URL. Check model streaming support."
      });
    }

    // The stream URL is a temporary URL returned by Replicate.
    const upstream = await fetch(streamUrl, {
      headers: { Accept: "text/event-stream" }
    });

    if (!upstream.ok || !upstream.body) {
      const details = await upstream.text().catch(() => "");
      console.error("Replicate stream error:", upstream.status, details);
      return res.status(502).json({ error: "Could not connect to Replicate's output stream." });
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let receivedOutput = false;
    let streamError = null;

    function sendOutput(text) {
      if (typeof text !== "string" || !text) return;
      receivedOutput = true;
      res.write(`event: output\ndata: ${JSON.stringify(text)}\n\n`);
    }

    function parseEvent(eventText) {
      let eventName = "message";
      const dataLines = [];

      for (const line of eventText.split(/\r?\n/)) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }

      const data = dataLines.join("\n");
      if (!data || data === "[DONE]") return;

      if (eventName === "error") {
        try {
          const err = JSON.parse(data);
          streamError = err.detail || err.error || err.message || data;
        } catch (_) {
          streamError = data;
        }
        return;
      }

      if (eventName === "done") {
        try {
          const end = JSON.parse(data);
          if (end.reason === "error") streamError = streamError || "Replicate reported a stream error.";
          if (end.reason === "canceled") streamError = "Generation was canceled.";
        } catch (_) {}
        return;
      }

      if (eventName !== "output" && eventName !== "message") return;

      // Some stream formats send JSON, others send plain text.
      let parsed;
      try { parsed = JSON.parse(data); } catch (_) { parsed = undefined; }

      if (typeof parsed === "string") {
        sendOutput(parsed);
      } else if (parsed && typeof parsed === "object") {
        if (typeof parsed.output === "string") sendOutput(parsed.output);
        else if (typeof parsed.text === "string") sendOutput(parsed.text);
        else if (typeof parsed.token === "string") sendOutput(parsed.token);
        else if (parsed.type === "output" && typeof parsed.data === "string") sendOutput(parsed.data);
      } else {
        sendOutput(data);
      }
    }

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (res.destroyed || res.writableEnded) {
        await reader.cancel().catch(() => {});
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || "";

      for (const event of events) parseEvent(event);
      if (streamError) break;
    }

    buffer += decoder.decode();
    if (buffer.trim()) parseEvent(buffer);
    reader.releaseLock();

    if (streamError) {
      console.error("Replicate stream reported an error:", streamError);
      if (!res.destroyed && !res.writableEnded) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: String(streamError) })}\n\n`);
        res.end();
      }
      return;
    }

    // If the model did not emit output events, inspect the finished prediction.
    if (!receivedOutput && predictionId && !res.destroyed && !res.writableEnded) {
      const finalResponse = await fetch(
        `https://api.replicate.com/v1/predictions/${encodeURIComponent(predictionId)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const finalPrediction = await finalResponse.json().catch(() => ({}));

      if (finalResponse.ok && finalPrediction.status === "succeeded") {
        const output = finalPrediction.output;
        const finalText = Array.isArray(output)
          ? output.map(item => typeof item === "string" ? item : "").join("")
          : typeof output === "string" ? output : "";

        if (finalText) sendOutput(finalText);
      } else if (finalPrediction.status === "failed") {
        streamError = finalPrediction.error || "Replicate generation failed.";
      }
    }

    if (!res.destroyed && !res.writableEnded) {
      if (!receivedOutput) {
        res.write(`event: error\ndata: ${JSON.stringify({
          error: streamError || "The model returned no text output. Check the prediction in Replicate."
        })}\n\n`);
      }
      res.write("event: done\ndata: {}\n\n");
      res.end();
    }
  } catch (error) {
    console.error("Code Studio API error:", error);

    if (!res.headersSent) {
      return res.status(500).json({
        error: error.message || "Generation failed. Check Vercel function logs."
      });
    }

    if (!res.destroyed && !res.writableEnded) {
      res.write(`event: error\ndata: ${JSON.stringify({
        error: "The connection was interrupted. Please try again."
      })}\n\n`);
      res.end();
    }
  }
}
