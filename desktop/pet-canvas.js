(() => {
  const canvas = document.getElementById("mascot");
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = false;
  let state = "idle";
  let startedAt = performance.now();

  const colors = {
    ink: "#17201e",
    dark: "#25302d",
    panel: "#e9efec",
    white: "#fbfdfc",
    mint: "#43c59e",
    coral: "#ef6a5b",
    amber: "#f1b84b",
    shadow: "rgba(23,32,30,0.16)",
  };

  function rect(x, y, w, h, color) {
    context.fillStyle = color;
    context.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }

  function draw(now) {
    const t = (now - startedAt) / 1000;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.scale(4, 4);
    const bounce = state === "running" ? Math.abs(Math.sin(t * 9)) * -3 : Math.sin(t * 2.2) * 1.2;
    const shake = state === "failed" ? Math.sin(t * 18) * 2 : 0;
    context.translate(shake, bounce);

    rect(26, 91, 44, 4, colors.shadow);
    rect(18, 44, 7, 25, colors.dark);
    rect(71, 44, 7, 25, colors.dark);
    rect(15, 64, 10, 7, colors.ink);
    rect(71, 64, 10, 7, colors.ink);
    if (state === "review") {
      rect(75, 38, 5, 26, colors.dark);
      rect(80, 36, 9, 5, colors.mint);
    } else if (state === "running") {
      rect(75, 51 + Math.sin(t * 9) * 5, 10, 5, colors.mint);
      rect(11, 51 - Math.sin(t * 9) * 5, 10, 5, colors.coral);
    } else {
      rect(76, 59, 8, 6, colors.mint);
    }

    rect(26, 72, 12, 18, colors.ink);
    rect(58, 72, 12, 18, colors.ink);
    rect(23, 86, 18, 7, colors.dark);
    rect(55, 86, 18, 7, colors.dark);
    rect(20, 22, 56, 58, colors.ink);
    rect(16, 30, 4, 35, colors.dark);
    rect(76, 30, 4, 35, colors.dark);
    rect(25, 17, 46, 8, colors.dark);
    rect(29, 12, 38, 6, colors.panel);
    rect(25, 29, 46, 36, colors.panel);
    rect(29, 33, 38, 28, colors.white);
    rect(25, 68, 46, 8, colors.dark);
    rect(45, 4, 6, 9, colors.dark);
    rect(43, 2, 10, 5, state === "failed" ? colors.coral : colors.mint);

    const blinking = state === "failed" || (state === "idle" && Math.floor(t * 2.1) % 13 === 0);
    const eye = state === "failed" ? colors.coral : colors.ink;
    rect(36, 43, 7, blinking ? 2 : 7, eye);
    rect(53, 43, 7, blinking ? 2 : 7, eye);
    if (state === "waiting") {
      rect(43, 55, 10, 2, colors.amber);
    } else if (state === "failed") {
      rect(43, 56, 10, 3, colors.coral);
      rect(46, 53, 4, 3, colors.coral);
    } else {
      rect(43, 54, 10, 3, colors.mint);
      rect(46, 57, 4, 2, colors.mint);
    }

    if (state === "review") {
      const scan = 34 + ((t * 20) % 24);
      rect(29, scan, 38, 2, "rgba(67,197,158,0.7)");
    }
    if (state === "running") {
      for (let index = 0; index < 4; index += 1) {
        const x = 5 + ((t * 24 + index * 21) % 88);
        rect(x, 78 - index * 7, 3, 3, index % 2 ? colors.coral : colors.mint);
      }
    }
    context.restore();
    requestAnimationFrame(draw);
  }

  window.shadowMascot = {
    setState(next) {
      if (next === state) return;
      state = next;
      startedAt = performance.now();
    },
  };
  requestAnimationFrame(draw);
})();

