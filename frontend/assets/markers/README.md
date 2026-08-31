# Markers

Puzzle Mode uses the **Hiro** marker, which is built into AR.js as
`preset="hiro"`. Nothing has to be trained, generated or shipped in this
folder for tracking to work — the pattern is compiled into the AR.js build.

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

If you would rather use your own image — a chess-themed one, for instance —
train it with the AR.js marker training tool, drop the resulting `.patt` file
in this folder, and change the marker element in `frontend/puzzle.html` from:

```html
<a-marker preset="hiro" ...>
```

to:

```html
<a-marker type="pattern" url="./assets/markers/your-marker.patt" ...>
```

Nothing else in the project needs to change: `puzzle-scene.js` attaches the
board to whichever marker element it finds by id.
