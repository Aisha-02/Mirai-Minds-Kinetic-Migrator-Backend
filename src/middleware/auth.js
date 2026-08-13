import jwt from "jsonwebtoken";
import { findUserById } from "../models/user.js";

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const token = header.slice("Bearer ".length).trim();

  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
    };
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requireRole(...allowedRoles) {
  return async (req, res, next) => {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const user = await findUserById(req.user.id);
      if (!user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      if (!allowedRoles.includes(user.role)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      req.user.role = user.role;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
