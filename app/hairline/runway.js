/* Runway — the Hairline figure that fills this site's empty state.
 * Wrapped in an IIFE: the engine's figures are written at top level, and two
 * of them on one page would collide on their destructured names. */
(function () {
/**
 * Runway: a long plate with three gates across it and a plane standing at the
 * threshold. The pointer picks a gate by the ground plane under it, the plane
 * rolls to that gate on a spring, and the gate it reached takes the bright
 * stroke from the one it left. The slider is the gate the plane stands at.
 *
 * The pattern: one continuous value, a spring for where, and a hit test on the
 * ground plane, which never moves. Groups are re-appended by x every time the
 * plane passes a gate, so a gate that is nearer the viewer paints over the
 * plane instead of the other way round.
 */
const {
  Cam, clamp, facing, fit, hull, open, poly, proj, ringAt, rrect, run, seg,
  spring, stepS, disposer, mk, pointer, register,
} = HL;

const L = 118, W = 17, T = 1.8;          // runway length, half-width, thickness
const GX = [34, 72, 108];                // the three gates, along x
const PL = 10.5, PW = 3.5, PH = 4.2;        // fuselage half-length, half-width, height
const WOFF = 5, WSPAN = 14.5;          // wing offset behind the nose, half span
const START = 4;                         // where the plane stands before any gate

/** A group drawn from prism()'s two path strings. */
function solidOf(parent, paths) {
  const g = mk("g", {}, parent);
  return { g, sil: mk("path", { d: paths.sil, class: "sil" }, g), cr: mk("path", { d: paths.crease, class: "nf lo" }, g) };
}

/** A solid whose top is inset from its foot: the tapered parts. */
function taper(parent, P, foot, top, inner, z0, z1, front) {
  const sil = poly(hull(ringAt(P, foot, z0).concat(ringAt(P, top, z1))));
  const crease = open(ringAt(P, run(inner, front), z1));
  return solidOf(parent, { sil, crease });
}

function mount({ stage, svg, read }, value) {
  const bag = disposer();

  // The camera is fitted to the plane at the last gate with its wings and tail
  // standing, so the most extreme pose is inside the 400 × 320 frame.
  const C = Cam(45, 0.5, 2.85);
  fit(C, [[0, -W, 0], [L, W, 0], [0, W, 0], [L, -W, 0], [GX[2], 0, PH + 6]], 200, 166);
  const P = proj(C), front = facing(C);

  const root = mk("g", {}, svg);

  // ---- the runway: one plate, a crease inside its rim, and dashed centre marks
  const outer = rrect(0, -W, L, W, 5, 8), inner = rrect(1.4, -W + 1.4, L - 1.4, W - 1.4, 3.6, 8);
  const runway = taper(root, P, outer, outer, inner, 0, T, front);
  runway.sil.setAttribute("class", "sil");
  for (let x = 12; x < L - 6; x += 16) {
    mk("path", { d: seg(P(x, 0, T + 0.1), P(x + 6, 0, T + 0.1)), class: "nf dash" }, runway.g);
  }

  // ---- the gates, each one thin plate across the runway
  const gates = GX.map((gx, i) => {
    const foot = rrect(gx - 2.1, -W + 0.6, gx + 2.1, W - 0.6, 1.4, 6);
    const top = rrect(gx - 1.4, -W + 1.2, gx + 1.4, W - 1.2, 1, 6);
    const s = taper(root, P, foot, top, top, T, T + 2.4, front);
    return { i, s, dots: [], x: gx };
  });
  // the gate's mark: a dot on each foot, placed from the projected corners
  for (const g of gates) {
    const d1 = mk("circle", { r: 1.5, class: "dot off" }, g.s.g), d2 = mk("circle", { r: 1.5, class: "dot off" }, g.s.g);
    g.dots = [d1, d2];
    const [ax, ay] = P(g.x, -W + 3, T + 2.6), [bx, by] = P(g.x, W - 3, T + 2.6);
    d1.setAttribute("cx", ax.toFixed(2)); d1.setAttribute("cy", ay.toFixed(2));
    d2.setAttribute("cx", bx.toFixed(2)); d2.setAttribute("cy", by.toFixed(2));
  }

  // ---- the plane: a tapered fuselage, two swept wings, a fin
  const body = { x: START };
  const plane = mk("g", {}, root);
  const fus = (x, z0) => {
    const foot = rrect(x - PL, -PW, x + PL, PW, PW, 8), top = rrect(x - PL + 1.6, -PW + 0.9, x + PL - 2.2, PW - 0.9, PW - 0.9, 8);
    return taper(plane, P, foot, top, top, z0, z0 + PH, front);
  };
  const wingAt = (x, z0) => {
    const shape = [[x - WOFF - 4.5, 0], [x - WOFF + 1.5, -WSPAN], [x - WOFF + 5.5, -WSPAN], [x - WOFF + 3.5, 0],
      [x - WOFF + 5.5, WSPAN], [x - WOFF + 1.5, WSPAN], [x - WOFF - 4.5, 0]];
    const ring = (dz) => shape.map(([u, v]) => { const [sx, sy] = P(u, v, z0 + dz); return { sx, sy, u, v, nz: 1 }; });
    const sil = poly(hull(ring(0).map((q) => [q.sx, q.sy]).concat(ring(0.9).map((q) => [q.sx, q.sy]))));
    return solidOf(plane, { sil, crease: open(ring(0.9).map((q) => [q.sx, q.sy])) });
  };

  const fuselage = fus(body.x, T + 0.6);
  const wing = { s: wingAt(body.x, T + 2.2), back: null };
  const fin = taper(plane, P, rrect(body.x - PL - 0.2, -0.9, body.x - PL + 3.6, 0.9, 0.8, 6),
    rrect(body.x - PL - 0.2, -0.6, body.x - PL + 2.4, 0.6, 0.5, 6), rrect(body.x - PL + 0.2, -0.5, body.x - PL + 2.2, 0.5, 0.4, 6), T + PH, T + PH + 2.6, front);

  /** Rebuild the plane's paths at world x, keeping the same nodes. */
  function drawPlane(x) {
    const f = rrect(x - PL, -PW, x + PL, PW, PW, 8), ft = rrect(x - PL + 1.6, -PW + 0.9, x + PL - 2.2, PW - 0.9, PW - 0.9, 8);
    fuselage.sil.setAttribute("d", poly(hull(ringAt(P, f, T + 0.6).concat(ringAt(P, ft, T + 0.6 + PH)))));
    fuselage.cr.setAttribute("d", open(ringAt(P, run(ft, front), T + 0.6 + PH)));
    const shape = [[x - WOFF - 4.5, 0], [x - WOFF + 1.5, -WSPAN], [x - WOFF + 5.5, -WSPAN], [x - WOFF + 3.5, 0],
      [x - WOFF + 5.5, WSPAN], [x - WOFF + 1.5, WSPAN], [x - WOFF - 4.5, 0]];
    const ring = (dz) => shape.map(([u, v]) => { const [sx, sy] = P(u, v, T + 2.2 + dz); return [sx, sy]; });
    wing.s.sil.setAttribute("d", poly(hull(ring(0).concat(ring(0.9)))));
    wing.s.cr.setAttribute("d", open(ring(0.9)));
    const f2 = rrect(x - PL - 0.2, -0.9, x - PL + 3.6, 0.9, 0.8, 6), t2 = rrect(x - PL - 0.2, -0.6, x - PL + 2.4, 0.6, 0.5, 6);
    fin.sil.setAttribute("d", poly(hull(ringAt(P, f2, T + PH).concat(ringAt(P, t2, T + PH + 2.6)))));
    fin.cr.setAttribute("d", open(ringAt(P, run(t2, front), T + PH + 2.6)));
  }
  drawPlane(body.x);

  // paint order: ascending x is back to front at this camera. Re-append only
  // when the order actually changes, and let the gate the plane has reached win.
  const order = [{ x: -1, el: runway.g }, ...gates.map((g) => ({ x: g.x, el: g.s.g })), { x: body.x, el: plane }];
  let lastOrder = "";
  function paint() {
    const sorted = order.slice().sort((a, b) => a.x - b.x);
    const key = sorted.map((o) => order.indexOf(o)).join(",");
    if (key === lastOrder) return;
    lastOrder = key;
    for (const o of sorted) root.appendChild(o.el);
  }
  paint();

  const sp = spring(START);
  let target = -1, lastDrawn = START;

  const B = register(stage, (dt) => {
    const moving = stepS(sp, dt);
    if (Math.abs(sp.x - lastDrawn) > 0.02) {
      lastDrawn = sp.x; body.x = sp.x; order[order.length - 1].x = sp.x;
      drawPlane(sp.x); paint();
    }
    return moving;
  });
  bag.add(B.unregister);

  /** The gate nearest the pointer on the ground plane, or -1 when it is off the plate. */
  function pick(pt) {
    const [u, v] = HL.unproj(C, pt[0], pt[1], T);
    if (v < -W || v > W) return -1;
    let best = -1, bd = Infinity;
    GX.forEach((gx, i) => { const d = Math.abs(gx - u); if (d < bd) { bd = d; best = i; } });
    return bd <= 26 ? best : -1;
  }

  function setGate(i, announce) {
    const changed = i !== target;
    if (announce !== false) read.textContent = i < 0 ? "rest" : "gate " + (i + 1);
    if (!changed) return;
    target = i;
    fuselage.sil.setAttribute("class", i < 0 ? "sil hi" : "sil");
    fuselage.cr.setAttribute("class", "nf lo");
    gates.forEach((g, k) => {
      g.s.sil.setAttribute("class", k === i ? "sil hi" : "sil");
      g.dots.forEach((d) => d.setAttribute("class", "dot " + (k === i ? "" : k < i ? "off" : "m")));
    });
    sp.t = i < 0 ? START : GX[i];
    B.wake();
  }

  bag.add(pointer(stage, { move: (p) => setGate(pick(p)), down: (p) => setGate(pick(p)), leave: () => setGate(-1) }));
  bag.add(() => svg.replaceChildren());

  setGate(value >= 3 ? 2 : value >= 1 ? 1 : 0, false);
  read.textContent = "rest";
  return { set: (v) => setGate(v >= 3 ? 2 : v >= 1 ? 1 : 0), destroy: bag.dispose };
}

hairline({
  name: "runway",
  means: "A runway with three gates: the plane rolls to the gate under the pointer.",
  rules: [1, 4, 6, 8],
  range: [0, 2, 3],
  tour: [[150, 210], [230, 150], [300, 120], null],
  mount,
});
})();
