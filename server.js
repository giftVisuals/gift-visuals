const express = require("express");
const path = require("path");

const apiRoutes = require("./routes/api");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

app.use("/api", apiRoutes);

app.use(express.static(path.join(__dirname, "public")));

app.get(["/", "/create", "/projects", "/profile", "/plans", "/billing"], (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Centralized error boundary: never leak internal error strings to the client.
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Something went wrong on our end. Please try again.", code: "INTERNAL_ERROR" });
});

app.listen(PORT, () => {
  console.log(`Gift Visuals server running on port ${PORT}`);
});
