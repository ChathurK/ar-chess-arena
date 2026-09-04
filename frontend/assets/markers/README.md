# Markers

Puzzle Mode uses a custom chess-themed marker, trained with the AR.js marker
training tool from `pattern-chess_ar_marker.png` into
`pattern-chess_ar_marker.patt`. `puzzle.html` points at the `.patt` file via
`<a-marker type="pattern" url="...">`, and `marker.html` displays the PNG
for scanning.

## Getting a marker to point the camera at

Open `marker.html` (the Puzzle Mode loading screen links straight to it) and
either print it or leave it open on a second screen.

Practical notes, in rough order of how often they matter:

* **Keep the white border clear.** The detector finds the marker by its black
  square outline, so it needs uninterrupted white all the way around.
* **Flat and unfolded.** A creased printout bends the square and tracking
  becomes unstable.
* **Watch for glare.** Displaying the marker on a glossy screen works, but a
  reflected window or ceiling light will break detection. Matte paper is more
  reliable.
* **Distance.** Roughly 20–50 cm from the phone. Too close and the marker
  leaves the frame; too far and there are not enough pixels to decode.
* **Even lighting.** Ordinary indoor light is fine; a hard shadow across half
  the marker is not.

## Using a different marker instead

Pick a source image that will train into a good pattern — the AR.js training
tool wants strong internal contrast and asymmetry so the four rotations are
never confused with each other; a busy photographic image (the kind a MindAR
`.mind` compiler wants) does not train reliably into a `.patt`. Train it with
the [AR.js marker training tool](https://ar-js-org.github.io/AR.js/three.js/examples/marker-training/examples/generator.html),
drop the resulting `.patt` file in this folder alongside the source PNG, and
update both:

* `frontend/puzzle.html` — the `url` on `<a-marker type="pattern" url="...">`
* `frontend/assets/markers/marker.html` — the `<img src="...">` so the
  scan page shows the same image the pattern was trained from

Nothing else in the project needs to change: `puzzle-scene.js` attaches the
board to whichever marker element it finds by id.
