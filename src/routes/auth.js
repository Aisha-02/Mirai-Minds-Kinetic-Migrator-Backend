import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import {
  createUser,
  findUserByEmail,
  findUserById,
  toPublicUser,
} from "../models/user.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const BCRYPT_ROUNDS = 12;
const ALLOWED_ROLES = new Set(["admin", "normal_user"]);

function normalizeEmail(email) {
  return String(email ?? "")
    .trim()
    .toLowerCase();
}

function validateCredentials(email, password) {
  const errors = [];

  if (!email || !EMAIL_RE.test(email)) {
    errors.push("A valid email is required");
  }

  if (!password || typeof password !== "string") {
    errors.push("Password is required");
  } else if (password.length < MIN_PASSWORD_LENGTH) {
    errors.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  return errors;
}

function signToken(user) {
  return jwt.sign(
    { email: user.email, role: user.role },
    process.env.JWT_SECRET,
    {
      subject: String(user.id),
      expiresIn: process.env.JWT_EXPIRES_IN || "1d",
    },
  );
}

router.post("/register", async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    const requestedRole = String(req.body?.role ?? "normal_user").trim();
    const role = ALLOWED_ROLES.has(requestedRole) ? requestedRole : null;

    const errors = validateCredentials(email, password);
    if (!role) {
      errors.push('role must be "admin" or "normal_user"');
    }
    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join("; ") });
    }

    const existing = await findUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await createUser({ email, passwordHash, role });

    return res.status(201).json({ user: toPublicUser(user) });
  } catch (err) {
    if (err?.code === "23505") {
      return res.status(409).json({ error: "An account with this email already exists" });
    }
    return next(err);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const user = await findUserByEmail(email);
    // Valid bcrypt hash used when user is missing so compare timing stays similar
    const passwordHash =
      user?.password_hash ??
      "$2a$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW";
    const matches = await bcrypt.compare(password, passwordHash);

    if (!user || !matches) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = signToken(user);

    return res.status(200).json({
      token,
      user: toPublicUser(user),
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await findUserById(req.user.id);
    if (!user) {
      return res.status(401).json({ error: "Authentication required" });
    }
    return res.status(200).json({ user: toPublicUser(user) });
  } catch (err) {
    return next(err);
  }
});

export default router;
