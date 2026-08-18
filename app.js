(function () {
  "use strict";

  var games = [];
  var gamesBySlug = {};

  var overlayEl = document.getElementById("overlay");
  var overlayPanel = document.getElementById("overlay-panel");
  var overlayImage = document.getElementById("overlay-image");
  var overlayTitle = document.getElementById("overlay-title");
  var overlayCount = document.getElementById("overlay-count");
  var overlaySource = document.getElementById("overlay-source");
  var btnPrev = document.getElementById("btn-prev");
  var btnNext = document.getElementById("btn-next");
  var gridEl = document.getElementById("grid");
  var emptyMsg = document.getElementById("empty-msg");
  var contributionsEl = document.getElementById("contributions");
  var contributionsList = document.getElementById("contributions-list");

  var overlayImageWrap = document.querySelector(".overlay-image-wrap");

  var overlayChrome = [btnPrev, btnNext, document.querySelector(".overlay-close"),
                        document.querySelector(".overlay-footer")];

  var current = { slug: null, index: 0 };
  var isAnimating = false; // guards nav/open/close from overlapping each other
  var SLIDE_MS = 220;
  var SLIDE_OFFSET = 44; // px

  // Multi-phase open/close timing -- vertical grow, a breath, horizontal
  // grow, a breath, then content fades in (and the exact reverse on close).
  var GROW_V_MS = 260;
  var GROW_H_MS = 260;
  var BREATH_MS = 90;
  var CONTENT_FADE_MS = 260;
  var EASE = "cubic-bezier(0.22, 0.8, 0.24, 1)";
  var CLOSED_SCALE_X = 0.04;
  var CLOSED_SCALE_Y = 0.05;

  // Locked once per game session (reset on open + on window resize) so the
  // outer panel/wrap never resizes while paging through a game's shots --
  // only the image content itself slides. See applyPixelScale().
  var sessionScale = null;
  var overlayBoxW = 0;
  var overlayBoxH = 0;

  // ---------- data loading ----------

  fetch("manifest.json")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      games = data.games || [];
      games.forEach(function (g) { gamesBySlug[g.slug] = g; });
      renderGrid();
      renderContributions();
      handleInitialUrl();
    })
    .catch(function (err) {
      console.error("Failed to load manifest.json", err);
      emptyMsg.classList.remove("hidden");
      emptyMsg.textContent = "Could not load manifest.json.";
    });

  // Best-effort: absence of contributions.json (or a fetch failure) just
  // means the section stays hidden -- not a hard dependency of the site.
  function renderContributions() {
    fetch("contributions.json")
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (entries) {
        entries = (entries || []).filter(function (e) { return gamesBySlug[e.slug]; });
        if (!entries.length) return;

        entries
          .slice()
          .sort(function (a, b) { return (b.date || "").localeCompare(a.date || ""); })
          .forEach(function (e) {
            var game = gamesBySlug[e.slug];
            var li = document.createElement("li");
            var dateStr = formatContribDate(e.date);
            li.innerHTML =
              "<strong>" + escapeHtml(game.title) + "</strong> &mdash; screenshots contributed by " +
              escapeHtml(e.contributor) +
              (e.platform ? " on " + escapeHtml(e.platform) : "") +
              (dateStr ? " (" + dateStr + ")" : "");
            contributionsList.appendChild(li);
          });

        contributionsEl.classList.remove("hidden");
      })
      .catch(function () { /* section just stays hidden */ });
  }

  function formatContribDate(dateStr) {
    if (!dateStr) return "";
    var d = new Date(dateStr + "T00:00:00");
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  }

  function escapeHtml(s) {
    var div = document.createElement("div");
    div.textContent = String(s == null ? "" : s);
    return div.innerHTML;
  }

  // ---------- grid ----------

  function renderGrid() {
    if (!games.length) {
      emptyMsg.classList.remove("hidden");
      return;
    }
    var frag = document.createDocumentFragment();
    games.forEach(function (game) {
      var available = !!game.available && game.shots.length > 0;

      // Pending (not-yet-downloaded) games render as a plain, non-focusable
      // div -- not a button -- so they're genuinely not clickable, not just
      // visually disabled. Doubles as a progress indicator on the homepage.
      var tile = document.createElement(available ? "button" : "div");
      tile.className = "tile" + (available ? "" : " tile-pending");
      if (available) {
        tile.type = "button";
        tile.setAttribute("aria-label", "View " + game.title);
      } else {
        tile.setAttribute("aria-label", game.short_title + " (not yet available)");
        tile.title = "Not downloaded yet";
      }

      var thumbWrap = document.createElement("div");
      thumbWrap.className = "tile-thumb-wrap";
      var img = document.createElement("img");
      img.loading = "lazy";
      img.src = game.thumb || (game.shots[0] || "");
      img.alt = game.title;
      thumbWrap.appendChild(img);

      var caption = document.createElement("span");
      caption.className = "tile-caption";
      var titleSpan = document.createElement("span");
      titleSpan.className = "tile-title";
      titleSpan.textContent = game.short_title || game.title;
      var yearSpan = document.createElement("span");
      yearSpan.className = "tile-year";
      yearSpan.textContent = game.year || "";
      caption.appendChild(titleSpan);
      caption.appendChild(yearSpan);

      tile.appendChild(thumbWrap);
      tile.appendChild(caption);

      if (available) {
        tile.addEventListener("click", function () {
          openOverlay(game.slug, 0, true);
        });
      }

      frag.appendChild(tile);
    });
    gridEl.appendChild(frag);
  }

  // ---------- overlay ----------

  function setPanelTransform(scaleX, scaleY, transitionCss) {
    overlayPanel.style.transition = transitionCss || "none";
    overlayPanel.style.transform = "scale(" + scaleX + ", " + scaleY + ")";
  }

  function setContentOpacity(value, transitionCss) {
    overlayImage.style.transition = transitionCss
      ? "opacity " + transitionCss
      : overlayImage.style.transition; // preserve transform transition set elsewhere
    overlayImage.style.opacity = value;
    overlayChrome.forEach(function (el) {
      if (!el) return;
      el.style.transition = transitionCss ? "opacity " + transitionCss : "none";
      el.style.opacity = value;
    });
  }

  function openOverlay(slug, index, pushHistory) {
    if (isAnimating) return;
    var game = gamesBySlug[slug];
    if (!game || !game.shots.length) return;

    index = ((index % game.shots.length) + game.shots.length) % game.shots.length;
    current.slug = slug;
    current.index = index;
    sessionScale = null; // recompute fresh for this game
    isAnimating = true;

    // reset to the fully-closed micro state before anything becomes visible
    overlayImage.style.transition = "none";
    overlayImage.style.transform = "translateX(0)";
    setContentOpacity(0, null);
    setPanelTransform(CLOSED_SCALE_X, CLOSED_SCALE_Y, null);

    overlayTitle.textContent = game.title;
    overlayCount.textContent = (index + 1) + " / " + game.shots.length;
    overlaySource.classList.toggle("hidden", game.source !== "contributed");
    overlayImage.alt = game.title + " screenshot " + (index + 1);
    overlayImage.onload = function () {
      applyPixelScale(overlayImage);
    };
    overlayImage.src = game.shots[index]; // lazy: only the requested shot is fetched
    preloadNeighbors(game, index);

    overlayEl.classList.remove("hidden");
    requestAnimationFrame(function () {
      overlayEl.classList.add("open"); // fades the backdrop in over its own transition

      // phase 1: grow vertically (full height, still needle-thin). A single
      // rAF is enough here -- the closed-state styles set synchronously
      // above are already committed by the time this callback runs.
      setPanelTransform(CLOSED_SCALE_X, 1, "transform " + GROW_V_MS + "ms " + EASE);

      setTimeout(function () {
        // phase 2: grow horizontally to full size
        setPanelTransform(1, 1, "transform " + GROW_H_MS + "ms " + EASE);

        setTimeout(function () {
          // phase 3: screenshot (and nav/footer/close chrome) fades in
          setContentOpacity(1, CONTENT_FADE_MS + "ms ease");

          setTimeout(function () { isAnimating = false; }, CONTENT_FADE_MS);
        }, GROW_H_MS + BREATH_MS);
      }, GROW_V_MS + BREATH_MS);
    });

    if (pushHistory) {
      var url = "#/" + slug + "/" + (index + 1);
      history.pushState({ slug: slug, index: index }, "", url);
    }

    document.addEventListener("keydown", onKeydown);
  }

  function showImage(game, index) {
    overlayImage.src = game.shots[index]; // lazy: only the requested shot is fetched
    overlayImage.alt = game.title + " screenshot " + (index + 1);
    overlayTitle.textContent = game.title;
    overlayCount.textContent = (index + 1) + " / " + game.shots.length;
    overlaySource.classList.toggle("hidden", game.source !== "contributed");

    overlayImage.onload = function () {
      applyPixelScale(overlayImage);
    };

    preloadNeighbors(game, index);
  }

  // Not a bulk preload of the whole game -- just the immediate prev/next
  // shots, so clicking through feels instant without ever fetching shots
  // the user hasn't navigated near. The browser's own image cache does
  // the rest; we don't hold onto these Image objects ourselves.
  function preloadNeighbors(game, index) {
    var total = game.shots.length;
    [1, -1].forEach(function (delta) {
      var i = ((index + delta) % total + total) % total;
      if (i === index) return; // single-shot game, nothing to preload
      var preloadImg = new Image();
      preloadImg.src = game.shots[i];
    });
  }

  function closeOverlay(pushHistory) {
    if (isAnimating) return;
    isAnimating = true;
    document.removeEventListener("keydown", onKeydown);

    // reverse sequence: content fades out, then horizontal shrink, then
    // vertical shrink (backdrop fades out concurrently with that last step)
    setContentOpacity(0, CONTENT_FADE_MS + "ms ease");

    setTimeout(function () {
      setPanelTransform(CLOSED_SCALE_X, 1, "transform " + GROW_H_MS + "ms " + EASE);

      setTimeout(function () {
        overlayEl.classList.remove("open"); // backdrop fade-out, timed with the final shrink
        setPanelTransform(CLOSED_SCALE_X, CLOSED_SCALE_Y, "transform " + GROW_V_MS + "ms " + EASE);

        setTimeout(function () {
          overlayEl.classList.add("hidden");
          isAnimating = false;
        }, GROW_V_MS);
      }, GROW_H_MS + BREATH_MS);
    }, CONTENT_FADE_MS + BREATH_MS);

    if (pushHistory !== false) {
      history.pushState({}, "", location.pathname + location.search);
    }
  }

  function navigate(delta) {
    if (isAnimating) return; // ignore rapid double-clicks mid-transition
    var game = gamesBySlug[current.slug];
    if (!game || game.shots.length < 2) return;
    var next = ((current.index + delta) % game.shots.length + game.shots.length) % game.shots.length;

    // direction: going "next" (delta > 0) slides the outgoing image left
    // and brings the new one in from the right; "prev" is mirrored.
    var dir = delta > 0 ? 1 : -1;
    isAnimating = true;

    overlayImage.style.transition =
      "transform " + SLIDE_MS + "ms cubic-bezier(0.4, 0, 0.2, 1), opacity " + SLIDE_MS + "ms ease";
    overlayImage.style.transform = "translateX(" + (-dir * SLIDE_OFFSET) + "px)";
    overlayImage.style.opacity = "0";

    setTimeout(function () {
      current.index = next;
      showImage(game, next);
      var url = "#/" + current.slug + "/" + (next + 1);
      history.replaceState({ slug: current.slug, index: next }, "", url);

      // snap to the opposite starting offset with no transition, then
      // animate back into place -- the classic slide-swap technique
      overlayImage.style.transition = "none";
      overlayImage.style.transform = "translateX(" + (dir * SLIDE_OFFSET) + "px)";
      overlayImage.style.opacity = "0";
      void overlayImage.offsetWidth; // force reflow so the above isn't merged into the next transition

      overlayImage.style.transition =
        "transform " + SLIDE_MS + "ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity " + SLIDE_MS + "ms ease";
      overlayImage.style.transform = "translateX(0)";
      overlayImage.style.opacity = "1";

      setTimeout(function () { isAnimating = false; }, SLIDE_MS);
    }, SLIDE_MS);
  }

  function onKeydown(e) {
    if (e.key === "Escape") closeOverlay();
    else if (e.key === "ArrowLeft") navigate(-1);
    else if (e.key === "ArrowRight") navigate(1);
  }

  btnPrev.addEventListener("click", function () { navigate(-1); });
  btnNext.addEventListener("click", function () { navigate(1); });

  document.querySelectorAll("[data-close]").forEach(function (el) {
    el.addEventListener("click", function () { closeOverlay(); });
  });

  // ---------- pixel-perfect nearest-neighbor scaling ----------
  // Browser does the scaling (image-rendering: pixelated in CSS); we just
  // pick an integer scale factor (2x or 4x, per the original site's
  // wallpaper-resolution spirit) based on viewport width, falling back to
  // a smaller integer factor if it wouldn't fit vertically.
  //
  // The scale is computed ONCE per game session (sessionScale) rather than
  // on every shot, and applied to the wrap element too -- otherwise, if
  // consecutive shots ever differ slightly in native size, the outer
  // panel/wrap would resize itself on every navigation, which reads as a
  // jarring frame-shift right in the middle of the slide animation.
  // Every shot in a game shares the wrap's fixed box; the image is
  // centered within it via flexbox.

  function computeScale(nw, nh) {
    var wideViewport = window.innerWidth >= 1100;
    var scale = wideViewport ? 4 : 2;

    var maxH = window.innerHeight * 0.68;
    var maxW = window.innerWidth * 0.86;

    while (scale > 1 && (nh * scale > maxH || nw * scale > maxW)) {
      scale -= 1;
    }
    return scale < 1 ? 1 : scale;
  }

  function applyPixelScale(img) {
    var nw = img.naturalWidth || 320;
    var nh = img.naturalHeight || 200;

    if (sessionScale === null) {
      sessionScale = computeScale(nw, nh);
      overlayBoxW = nw * sessionScale;
      overlayBoxH = nh * sessionScale;
      overlayImageWrap.style.width = overlayBoxW + "px";
      overlayImageWrap.style.height = overlayBoxH + "px";
    }

    // Recovered screenshots for the same game don't all share one native
    // resolution (different capture sizes came through the archive), so
    // fit each image within the session-locked box rather than sizing it
    // to its own dimensions -- keeps the frame a constant size instead of
    // jumping between shots. Letterboxed (centered via flexbox) when a
    // shot's aspect ratio doesn't match the locking image's.
    var fitScale = Math.min(overlayBoxW / nw, overlayBoxH / nh);
    img.style.width = (nw * fitScale) + "px";
    img.style.height = (nh * fitScale) + "px";
  }

  window.addEventListener("resize", function () {
    if (!overlayEl.classList.contains("hidden") && overlayImage.naturalWidth) {
      sessionScale = null; // viewport changed -- recompute and re-lock
      applyPixelScale(overlayImage);
    }
  });

  // ---------- URL deep-linking ----------

  function parseHash() {
    var m = /^#\/([^/]+)\/(\d+)$/.exec(location.hash);
    if (!m) return null;
    return { slug: m[1], index: parseInt(m[2], 10) - 1 };
  }

  function handleInitialUrl() {
    var parsed = parseHash();
    if (parsed && gamesBySlug[parsed.slug]) {
      openOverlay(parsed.slug, parsed.index, false);
    }
  }

  window.addEventListener("popstate", function () {
    var parsed = parseHash();
    if (parsed && gamesBySlug[parsed.slug]) {
      openOverlay(parsed.slug, parsed.index, false);
    } else {
      closeOverlay(false);
    }
  });
})();
