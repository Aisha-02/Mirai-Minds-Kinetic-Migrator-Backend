import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { answerAssistantChat } from "../services/assistantChat.js";

const router = Router();

router.post("/chat", requireAuth, async (req, res, next) => {
  try {
    const scope = String(req.body?.scope || "").trim();
    const messages = req.body?.messages;
    const context = req.body?.context;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages[] is required" });
    }

    const result = await answerAssistantChat({
      scope,
      messages,
      context: context && typeof context === "object" ? context : {},
    });

    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
});

export default router;
