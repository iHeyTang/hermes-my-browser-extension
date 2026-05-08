/**
 * Toolbar icon — drawn dynamically with OffscreenCanvas so the entire
 * foreground reflects the connection state. The mark is a minimal "two
 * nodes joined by a line", a literal bridge.
 *
 * The full icon (not a corner badge) carries the state: green = connected,
 * orange = connecting, gray = disconnected.
 */

const STATUS_COLORS = {
  connected:    "#4CAF50",
  connecting:   "#FFA726",
  disconnected: "#9E9E9E",
};

const ICON_SIZES = [16, 32, 48, 128];

function drawRoundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// Coordinates are written against a virtual 128 unit canvas and scaled so
// the mark stays visually identical at every requested resolution.
function drawIcon(ctx, size, color) {
  const s = size / 128;
  ctx.imageSmoothingEnabled = true;

  ctx.fillStyle = "#1a1a2e";
  drawRoundedRect(ctx, 0, 0, size, size, 22 * s);
  ctx.fill();

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = "round";

  // Connecting bar (sits behind the endpoints).
  ctx.lineWidth = 14 * s;
  ctx.beginPath();
  ctx.moveTo(34 * s, 64 * s);
  ctx.lineTo(94 * s, 64 * s);
  ctx.stroke();

  // Two endpoint nodes.
  ctx.beginPath();
  ctx.arc(30 * s, 64 * s, 22 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(98 * s, 64 * s, 22 * s, 0, Math.PI * 2);
  ctx.fill();
}

export async function applyIcon(connState) {
  const color = STATUS_COLORS[connState] || STATUS_COLORS.disconnected;
  const imageData = {};
  for (const size of ICON_SIZES) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    drawIcon(ctx, size, color);
    imageData[size] = ctx.getImageData(0, 0, size, size);
  }
  try {
    await chrome.action.setIcon({ imageData });
  } catch (e) {
    console.warn("[hermes-bridge] setIcon failed:", e);
  }
  // The colored icon itself is the indicator — keep the badge clear.
  chrome.action.setBadgeText({ text: "" });
}
