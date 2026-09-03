"""
extract_chess_pieces.py
=======================
Extracts the six unique chess piece geometries from a downloaded third-party
chess set (a single .glb containing a whole set-up board) and re-exports each
one as a small, web-optimised .glb that drops into AR Chess Arena's existing
piece pipeline.

This is the imported-asset counterpart to generate_chess_pieces.py. Both write
models that obey the same conventions, so the frontend can use either set by
changing MODEL_BASE_PATH in frontend/js/config.js and nothing else.

WHY A SCRIPT RATHER THAN USING THE DOWNLOAD DIRECTLY
-----------------------------------------------------
The source file is not six models. It is one scene holding a complete board:
32 pre-placed pieces plus the board itself, 9.3 MB, 309,796 triangles, with UV
coordinates it never samples (it has no textures at all) and 32-bit indices it
does not need. Dropped in as-is it would put ~308,000 triangles on screen for a
full board -- roughly eight times what the generated set costs -- on a phone
that is already decoding a camera feed and running spatial tracking.

So this script does the work that makes the asset usable:

  1. classifies all 32 pieces by where they stand on the board,
  2. keeps one instance of each of the six types (a white one, so it already
     faces down the board the way the frontend expects),
  3. splits each into its body mesh and its metallic accent mesh, which is
     what lets the frontend tint the two separately,
  4. decimates each to a face budget suited to the target device,
  5. strips the unused UV channel,
  6. rescales the whole set by ONE factor so the pieces keep the proportions
     the original artist gave them, and re-origins each piece,
  7. reloads every export and verifies it before trusting it.

WHY ONE SHARED SCALE FACTOR RATHER THAN PER-PIECE TARGET HEIGHTS
-----------------------------------------------------------------
generate_chess_pieces.py sets each piece to its own target height, because it
authors the silhouettes itself and chooses those proportions deliberately. An
imported set already has proportions, and they are part of what makes it look
like one set rather than six unrelated models. So the whole set is scaled by a
single factor, chosen so the king matches KING_HEIGHT_IN_SQUARES, and every
other piece follows from that. Note this means the imported knight comes out
slightly SHORTER than the imported pawn -- that is the original artist's
proportion, not a bug, and the script reports it rather than silently
"fixing" it.

CONVENTIONS SHARED WITH generate_chess_pieces.py (do not change casually)
--------------------------------------------------------------------------
* Units   : 1.0 model unit == the width of one board square.
* Up axis : +Y (glTF convention).
* Facing  : +Z, so the knight looks at its opponent. The frontend rotates
            black pieces by 180 degrees; see piece-loader.js.
* Origin  : the exact centre of the piece's base, so the frontend positions a
            piece with a single position.set.

WHAT THE FRONTEND SEES
-----------------------
Each exported .glb contains two named meshes, "body" and "accent". The current
piece-loader.js traverses every mesh and applies one tint, so these files work
unchanged -- the piece simply comes out a single colour. To get the two-tone
look the source set is prized for, piece-loader.js needs to tint by mesh name
and PIECE_COLOURS in config.js needs a body/accent pair per side.

LICENSING -- READ THIS BEFORE SHIPPING
---------------------------------------
Unlike the generated set, imported assets carry obligations. This script reads
the licence and author out of the source file's own metadata, prints them, and
writes an ATTRIBUTION.md next to the models. A CC-BY asset requires crediting
the author in the README, in the running application, and in the technical
report. Do not skip this.

Requires: pip install trimesh numpy fast_simplification

Run:  python scripts/extract_chess_pieces.py --source path/to/chess.glb
Out:  frontend/assets/models-imported/{pawn,rook,knight,bishop,queen,king}.glb
      frontend/assets/models-imported/ATTRIBUTION.md
"""

import argparse
import json
import os
import struct
from collections import defaultdict

import numpy as np
import trimesh

# --------------------------------------------------------------------------
# Output configuration
# --------------------------------------------------------------------------

SCRIPT_DIRECTORY = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIRECTORY)

# Deliberately NOT the same directory as the generated models. Keeping both
# sets on disk means switching between them is a one-line config change, and
# the generated set stays available as a fallback that needs no attribution.
DEFAULT_OUTPUT_DIRECTORY = os.path.join(
    PROJECT_ROOT, "frontend", "assets", "models-imported"
)

# The same neutral ivory generate_chess_pieces.py uses. The frontend overwrites
# this at runtime, but a sane base colour means the file also looks correct in
# any glTF viewer, and it is what the piece falls back to if tinting is ever
# skipped.
IVORY_BASE_COLOUR = [232, 224, 208, 255]

# Warm metallic, for the accent mesh. Same reasoning as above.
ACCENT_BASE_COLOUR = [219, 105, 9, 255]

# Height of the king, in board squares. Everything else is scaled from this by
# the source set's own proportions. 0.94 matches generate_chess_pieces.py, so
# the two sets are interchangeable without touching board or camera framing.
KING_HEIGHT_IN_SQUARES = 0.94

# A piece must never visually spill onto its neighbouring squares. Shared with
# the generator, and enforced by the same verification step.
MAXIMUM_PIECE_RADIUS = 0.40


# --------------------------------------------------------------------------
# Face budgets
# --------------------------------------------------------------------------

# Triangles allowed per piece after decimation.
#
# "mobile" is sized against the real constraint: a full 32-piece board. At
# these budgets that board measures 35,328 triangles, which sits just under
# what the generated set already costs (39,680) -- so Duel Mode gets a much
# better looking set for no extra load. Pieces are turned solids of revolution
# with far more radial segments than a 4 cm object on a phone screen can show,
# which is why an 8x cut is visually close to free.
#
# "high" is for Puzzle Mode, which only ever displays three to five pieces, and
# for desktop testing. "source" keeps the original density, which is useful for
# before-and-after comparison shots in the technical report.
DECIMATION_PRESETS = {
    "mobile": {
        "pawn": 900,
        "rook": 900,
        "knight": 1600,
        "bishop": 1000,
        "queen": 1600,
        "king": 1400,
    },
    "high": {
        "pawn": 2600,
        "rook": 2600,
        "knight": 5000,
        "bishop": 3000,
        "queen": 5000,
        "king": 4200,
    },
    "source": None,
}

# The body must never be starved by an accent that happens to be dense. The
# source queen is the case that forces this: her coronet is 28,160 of her
# 34,878 triangles, so a purely proportional split would leave the body itself
# with almost nothing.
MINIMUM_BODY_SHARE_OF_BUDGET = 0.45
MINIMUM_FACES_PER_MESH = 80

# Smallest number of faces a single shell may be reduced to. A turned piece in
# this source is a stack of separate closed solids -- body segments with metal
# rings between them -- and a ring pushed below roughly this many faces stops
# reading as a ring at all. Because this is a floor, a piece made of many small
# shells can finish slightly above its budget; that is the intended trade and
# the script reports the real figure rather than the requested one.
MINIMUM_FACES_PER_COMPONENT = 24


# --------------------------------------------------------------------------
# Reading the source file
# --------------------------------------------------------------------------

# Material names in the source that belong to a piece's metallic accent rather
# than its body. Everything else on a piece is body.
ACCENT_MATERIAL_NAMES = {"Coppper", "gold"}

# Material names used for the light-coloured side's bodies. Used only to choose
# which of a piece type's instances to extract, never to identify a piece.
LIGHT_BODY_MATERIAL_NAMES = {"white"}

# Nodes that are the board rather than a piece, and are discarded: the frontend
# builds its board procedurally so that individual squares can be highlighted,
# which a single 64-triangle mesh covering all 32 light squares cannot support.
BOARD_NODE_NAMES = {"Plane"}


def read_source_credits(source_path):
    """
    Pull author/licence/title straight out of the .glb's own asset metadata.

    Reads the glTF JSON chunk directly rather than going through trimesh, which
    discards `asset.extras`. Sketchfab writes the attribution the download is
    subject to into exactly that field, so it is the most reliable statement of
    the obligation available -- better than a note pasted from a web page that
    may have been edited since.
    """
    with open(source_path, "rb") as source_file:
        header = source_file.read(20)
        magic, _version, _length, json_length, chunk_type = struct.unpack("<4sIII4s", header)
        if magic != b"glTF" or chunk_type != b"JSON":
            raise ValueError(f"{source_path} is not a binary glTF (.glb) file")
        gltf = json.loads(source_file.read(json_length))

    extras = gltf.get("asset", {}).get("extras", {}) or {}
    return {
        "title": extras.get("title", "(untitled)"),
        "author": extras.get("author", "(author not recorded in the file)"),
        "license": extras.get("license", "(licence not recorded in the file)"),
        "source": extras.get("source", source_path),
        "generator": gltf.get("asset", {}).get("generator", "(unknown)"),
    }


def group_geometry_into_pieces(scene):
    """
    Collapse the scene's flat list of meshes back into whole pieces.

    trimesh flattens a glTF node hierarchy, so a piece arrives as two unrelated
    meshes named like "Circle.007_white_0" and "Circle.007_Coppper_0". The part
    before the final "_<material>_0" is the node they shared in the original
    file, which is what identifies them as one piece.

    Returns {node_name: [(geometry_name, material_name, world_transform), ...]}.
    """
    pieces = defaultdict(list)
    for scene_node in scene.graph.nodes_geometry:
        world_transform, geometry_name = scene.graph[scene_node]

        # A name that does not follow the pattern belongs to some other model,
        # not this one. Rather than crashing on the unpack, fall back to
        # treating the whole name as the piece and leaving its material
        # unknown: classify_pieces then rejects the file with a message that
        # actually says what went wrong.
        name_parts = geometry_name.rsplit("_", 2)
        if len(name_parts) == 3:
            node_name, material_name, _suffix = name_parts
        else:
            node_name, material_name = geometry_name, ""

        if node_name in BOARD_NODE_NAMES:
            continue
        pieces[node_name].append((geometry_name, material_name, world_transform))
    return pieces


def measure_piece(scene, members):
    """World-space bounds, centre and face count for one grouped piece."""
    lower = np.full(3, np.inf)
    upper = np.full(3, -np.inf)
    face_count = 0
    for geometry_name, _material_name, world_transform in members:
        geometry = scene.geometry[geometry_name]
        face_count += len(geometry.faces)
        world_vertices = trimesh.transform_points(geometry.vertices, world_transform)
        lower = np.minimum(lower, world_vertices.min(axis=0))
        upper = np.maximum(upper, world_vertices.max(axis=0))
    return {
        "faces": face_count,
        "lower": lower,
        "upper": upper,
        "centre_x": (lower[0] + upper[0]) / 2.0,
        "centre_z": (lower[2] + upper[2]) / 2.0,
        "height": upper[1] - lower[1],
    }


# --------------------------------------------------------------------------
# Classification
# --------------------------------------------------------------------------

# How many of each piece a correctly-read board must contain. Asserting this is
# the whole safety net: if a different chess model is passed in, or the source
# is ever re-exported with a different layout, the script must fail loudly here
# rather than quietly exporting a bishop labelled "queen".
EXPECTED_PIECE_COUNTS = {
    "pawn": 16,
    "rook": 4,
    "knight": 4,
    "bishop": 4,
    "queen": 2,
    "king": 2,
}


def classify_pieces(measurements):
    """
    Work out which piece each node is, from where it stands on the board.

    Position is used rather than mesh names because the names in the source are
    modelling-tool leftovers ("Circle.011", "Circle.027") that carry no meaning
    and no ordering. A chess set at its starting position, on the other hand,
    identifies every piece unambiguously by square -- which is a property of
    chess, not of this particular file.

    The board is read purely in relative terms: rank and file spacing are
    derived from the pieces themselves, so the same logic works for any set-up
    board at any scale.
    """
    # Checked before anything is derived from the layout, so a file that is not
    # a chess set is rejected with a sentence rather than an index error from
    # somewhere deep in the geometry below.
    expected_piece_total = sum(EXPECTED_PIECE_COUNTS.values())
    if len(measurements) != expected_piece_total:
        raise ValueError(
            f"expected {expected_piece_total} pieces on a set-up board, found "
            f"{len(measurements)}. This script reads a complete chess set at its "
            "starting position; it cannot extract pieces from a file that is not one."
        )

    centres_x = np.array([m["centre_x"] for m in measurements.values()])
    centres_z = np.array([m["centre_z"] for m in measurements.values()])

    # The two back ranks are the extremes in Z; the two pawn ranks sit just
    # inside them. Splitting halfway between those two distances separates the
    # pawns from everything else.
    back_rank_distance = np.abs(centres_z).max()
    pawn_rank_distance = np.abs(centres_z)[np.abs(centres_z) < back_rank_distance * 0.95].max()
    rank_split = (back_rank_distance + pawn_rank_distance) / 2.0

    # Files are evenly spaced across the board, and the outermost pieces stand
    # on the two edge files, so the gap between adjacent files is the full
    # width divided by the seven gaps between eight files.
    file_spacing = np.abs(centres_x).max() * 2.0 / 7.0

    # Distance from the centre line, in files: the two centre files sit at 0.5,
    # then 1.5, 2.5 and 3.5 going outwards. Testing against the midpoints
    # between those tolerates the small placement jitter a hand-built scene has.
    def files_from_centre(centre_x):
        return abs(centre_x) / file_spacing

    classified = {}
    for node_name, measurement in measurements.items():
        if abs(measurement["centre_z"]) < rank_split:
            classified[node_name] = "pawn"
            continue

        distance_in_files = files_from_centre(measurement["centre_x"])
        if distance_in_files > 3.0:
            classified[node_name] = "rook"
        elif distance_in_files > 2.0:
            classified[node_name] = "knight"
        elif distance_in_files > 1.0:
            classified[node_name] = "bishop"
        else:
            # The king and queen stand side by side on the two centre files, so
            # distance from the centre cannot separate them. Height can, and
            # reliably: the king is the tallest piece in every chess set, which
            # is exactly why it is the piece the whole set is scaled from.
            classified[node_name] = "king_or_queen"

    centre_file_nodes = [n for n, t in classified.items() if t == "king_or_queen"]
    if len(centre_file_nodes) != 4:
        raise ValueError(
            f"expected 4 pieces on the two centre files, found {len(centre_file_nodes)}"
        )
    centre_file_nodes.sort(key=lambda n: measurements[n]["height"], reverse=True)
    for node_name in centre_file_nodes[:2]:
        classified[node_name] = "king"
    for node_name in centre_file_nodes[2:]:
        classified[node_name] = "queen"

    found_counts = defaultdict(int)
    for piece_type in classified.values():
        found_counts[piece_type] += 1
    if dict(found_counts) != EXPECTED_PIECE_COUNTS:
        raise ValueError(
            "the source does not look like a chess set at its starting position.\n"
            f"  expected: {EXPECTED_PIECE_COUNTS}\n"
            f"  found:    {dict(found_counts)}"
        )

    return classified


def choose_instance_to_extract(node_names, measurements, members_by_node):
    """
    Pick which of a piece type's instances to export.

    Prefer a piece from the side sitting at negative Z whose body uses the
    light material. Two reasons, both load-bearing: that side's body colour
    matches the neutral base the frontend tints from; and those pieces face
    towards +Z, which is the facing convention the frontend and the generated
    set both assume (piece-loader.js rotates black pieces 180 degrees, so a
    piece authored facing the wrong way would leave the knight staring at its
    own back rank).
    """
    def sort_key(node_name):
        has_light_body = any(
            material_name in LIGHT_BODY_MATERIAL_NAMES
            for _geometry_name, material_name, _transform in members_by_node[node_name]
        )
        return (not has_light_body, measurements[node_name]["centre_z"])

    return sorted(node_names, key=sort_key)[0]


# --------------------------------------------------------------------------
# Mesh preparation
# --------------------------------------------------------------------------

def build_world_space_mesh(scene, members, wanted_accent):
    """
    Merge a piece's body meshes, or its accent meshes, into one world-space mesh.

    Returns None when the piece has no mesh of the requested kind, which is a
    legitimate outcome -- not every imported set gives every piece an accent.
    """
    parts = []
    for geometry_name, material_name, world_transform in members:
        is_accent = material_name in ACCENT_MATERIAL_NAMES
        if is_accent != wanted_accent:
            continue
        part = scene.geometry[geometry_name].copy()
        part.apply_transform(world_transform)
        parts.append(part)

    if not parts:
        return None

    merged = trimesh.util.concatenate(parts)
    # The source stores its vertices unwelded. Quadric decimation works by
    # collapsing edges, so it needs the mesh to actually be connected -- given
    # a soup of unshared vertices it will chew holes in the surface instead of
    # simplifying it.
    merged.merge_vertices()
    return merged


def allocate_face_budget(body_faces, accent_faces, total_budget):
    """
    Split a piece's triangle budget between its body and its accent.

    Proportional to their original densities, then floored so neither can be
    starved. See MINIMUM_BODY_SHARE_OF_BUDGET for the case that motivates it.
    """
    if accent_faces == 0:
        return total_budget, 0

    body_share = body_faces / float(body_faces + accent_faces)
    body_share = max(body_share, MINIMUM_BODY_SHARE_OF_BUDGET)

    body_budget = int(round(total_budget * body_share))
    accent_budget = total_budget - body_budget

    body_budget = max(body_budget, MINIMUM_FACES_PER_MESH)
    accent_budget = max(accent_budget, MINIMUM_FACES_PER_MESH)
    return body_budget, accent_budget


def label_connected_components(mesh):
    """
    Return a component label for every face, by union-find over shared vertices.

    trimesh can do this itself, but only when scipy or networkx happens to be
    installed. Doing it here in plain numpy keeps this script's dependencies the
    same as generate_chess_pieces.py's, which matters because the two are meant
    to be interchangeable halves of one pipeline.
    """
    parent = np.arange(len(mesh.vertices))

    def find(vertex_index):
        while parent[vertex_index] != vertex_index:
            parent[vertex_index] = parent[parent[vertex_index]]  # path compression
            vertex_index = parent[vertex_index]
        return vertex_index

    for face in mesh.faces:
        root = find(face[0])
        for vertex_index in face[1:]:
            other_root = find(vertex_index)
            if other_root != root:
                parent[other_root] = root

    return np.array([find(face[0]) for face in mesh.faces])


def cap_boundary_loops(mesh):
    """
    Close a shell's open rims by fan-triangulating each boundary loop.

    WHY THIS IS NEEDED BEFORE DECIMATING
    -------------------------------------
    Quadric decimation pins boundary edges, because moving them would visibly
    change the silhouette of an open surface. The source's pawn base is an
    open-bottomed cylinder with a 52-edge rim, and that rim alone holds it at
    636 faces no matter how small a budget it is given -- asked for 141, it
    returns 637. Capping the rim first lets it reach its target, which on a
    full board is around eight thousand triangles spent on the undersides of
    sixteen pawns.

    Fan-triangulating from the loop's centroid is exact here rather than merely
    adequate: every rim in a turned piece is a circle, so the centroid lies
    inside it and the fan cannot self-intersect. Winding is taken from the
    directed boundary edge so the cap agrees with the surface around it.

    trimesh.repair.fill_holes does this too, but only when networkx is
    installed; this keeps the script's dependencies matching the generator's.
    """
    # Each face contributes three directed edges. An edge whose reverse is
    # absent has no neighbouring face, so it lies on a boundary.
    directed_edges = np.vstack(
        [mesh.faces[:, [0, 1]], mesh.faces[:, [1, 2]], mesh.faces[:, [2, 0]]]
    )
    edge_set = {(int(start), int(end)) for start, end in directed_edges}
    boundary_edges = [
        (start, end) for (start, end) in edge_set if (end, start) not in edge_set
    ]
    if not boundary_edges:
        return mesh

    # Walking start -> end repeatedly traces each rim. A vertex shared by two
    # rims would be ambiguous here; the `visited` guard means such a case ends
    # the walk rather than looping forever, leaving that rim uncapped, which is
    # the same outcome as not calling this function at all.
    next_vertex = {start: end for start, end in boundary_edges}

    vertices = mesh.vertices
    faces = list(mesh.faces)
    visited = set()

    for loop_start in list(next_vertex.keys()):
        if loop_start in visited:
            continue
        loop = []
        current = loop_start
        while current in next_vertex and current not in visited:
            visited.add(current)
            loop.append(current)
            current = next_vertex[current]
        if len(loop) < 3:
            continue

        centre_index = len(vertices)
        vertices = np.vstack([vertices, vertices[loop].mean(axis=0)])
        for position in range(len(loop)):
            start = loop[position]
            end = loop[(position + 1) % len(loop)]
            # Reversed relative to the boundary edge, so the cap faces outwards.
            faces.append([end, start, centre_index])

    return trimesh.Trimesh(vertices, np.array(faces), process=False)


def decimate_mesh(mesh, face_budget):
    """
    Reduce a mesh towards a face budget, one connected component at a time.

    PER COMPONENT IS NOT A REFINEMENT -- IT IS THE WHOLE POINT
    -----------------------------------------------------------
    These pieces are turned solids, which in this source means a stack of
    separate closed shells: body segments with metal rings between them, not
    one continuous surface. A pawn body alone is seven such shells.

    Handed the whole stack at once, quadric decimation spends the budget on the
    largest shells and deletes the small ones outright. Decimating the source
    pawn that way removed everything above the collar -- the head simply
    disappeared and the piece came out 30% shorter than it went in, which is
    exactly the kind of failure that looks fine in a file listing and obvious
    on a phone.

    Giving each shell its own slice of the budget keeps every part of the piece
    present. The height check in verify_exported_model is what catches it if
    this ever regresses.
    """
    if face_budget is None or len(mesh.faces) <= face_budget:
        return mesh

    component_labels = label_connected_components(mesh)
    unique_labels, faces_per_component = np.unique(component_labels, return_counts=True)
    total_faces = float(faces_per_component.sum())

    simplified_components = []
    for label, component_face_count in zip(unique_labels, faces_per_component):
        component = mesh.submesh([component_labels == label], append=True)

        component_budget = max(
            int(round(face_budget * component_face_count / total_faces)),
            MINIMUM_FACES_PER_COMPONENT,
        )
        if component_face_count > component_budget:
            component = cap_boundary_loops(component)
            component = component.simplify_quadric_decimation(face_count=component_budget)
            # Decimation can leave zero-area faces behind. They contribute
            # nothing to the silhouette but still cost bandwidth, and they
            # produce NaN normals on some renderers.
            component.update_faces(component.nondegenerate_faces())
            component.remove_unreferenced_vertices()

        simplified_components.append(component)

    return trimesh.util.concatenate(simplified_components)


def apply_material(mesh, name, base_colour, metallic, roughness):
    """
    Give a mesh a plain PBR material and, crucially, no UV coordinates.

    The source carries TEXCOORD_0 on all 172,808 of its vertices and has zero
    textures to sample with them -- 1.38 MB of the download is a UV channel
    nothing reads. Replacing the visual outright is what drops it.
    """
    mesh.visual = trimesh.visual.TextureVisuals(
        material=trimesh.visual.material.PBRMaterial(
            name=name,
            baseColorFactor=base_colour,
            metallicFactor=metallic,
            roughnessFactor=roughness,
        )
    )
    return mesh


# --------------------------------------------------------------------------
# Export and verification
# --------------------------------------------------------------------------

def export_piece(body_mesh, accent_mesh, model_path):
    """
    Write one piece as a .glb holding a "body" mesh and an "accent" mesh.

    They stay separate rather than being merged so the frontend can tint them
    independently -- the two-tone look is the main reason to prefer this set
    over the generated one, and merging would throw it away.
    """
    scene = trimesh.Scene()
    scene.add_geometry(body_mesh, geom_name="body", node_name="body")
    if accent_mesh is not None:
        scene.add_geometry(accent_mesh, geom_name="accent", node_name="accent")
    scene.export(model_path)


def verify_exported_model(model_path, expected_height):
    """
    Reload an exported .glb and sanity-check it before it is trusted.

    Deliberately the same checks generate_chess_pieces.py runs, for the same
    reason: a model that exports without error can still be unusable, and every
    one of these failures is far cheaper to catch here than on a phone in AR.
    Two checks are added that only an imported asset needs -- that the two-mesh
    split survived the round trip, and that the unused UV channel really is gone.
    """
    reloaded_scene = trimesh.load(model_path, process=False)
    mesh_names = set(reloaded_scene.geometry.keys())
    assert "body" in mesh_names, f"exported file lost its body mesh (has {mesh_names})"

    for geometry in reloaded_scene.geometry.values():
        assert getattr(geometry.visual, "uv", None) is None, (
            "the unused UV channel survived the export"
        )

    reloaded_mesh = trimesh.load(model_path, force="mesh", process=False)

    assert np.isfinite(reloaded_mesh.vertices).all(), "model contains NaN or infinite vertices"
    assert len(reloaded_mesh.faces) > 0, "model contains no faces"

    lower_bounds, upper_bounds = reloaded_mesh.bounds
    actual_height = upper_bounds[1] - lower_bounds[1]
    # A looser tolerance than the generator's: decimation moves boundary
    # vertices by a fraction of a millimetre, and forcing an exact height
    # afterwards would break the single shared scale factor that is what keeps
    # the set's proportions intact.
    assert abs(actual_height - expected_height) < 0.02, (
        f"height {actual_height:.3f} does not match the expected {expected_height:.3f}"
    )
    assert abs(lower_bounds[1]) < 1e-4, "the base of the model does not sit on y = 0"

    widest_radius = float(
        np.sqrt(reloaded_mesh.vertices[:, 0] ** 2 + reloaded_mesh.vertices[:, 2] ** 2).max()
    )
    assert widest_radius <= MAXIMUM_PIECE_RADIUS + 1e-3, "model is wider than one board square"

    return {
        "faces": len(reloaded_mesh.faces),
        "meshes": len(mesh_names),
        "height": actual_height,
        "radius": widest_radius,
        "kilobytes": os.path.getsize(model_path) / 1024.0,
    }


def write_attribution_file(output_directory, credits, source_path):
    """
    Record the licence obligation next to the files it applies to.

    A licence noted only in a commit message or a chat window is a licence that
    will be missing from the submission. Writing it beside the models means it
    travels with them.
    """
    attribution_path = os.path.join(output_directory, "ATTRIBUTION.md")
    with open(attribution_path, "w", encoding="utf-8") as attribution_file:
        attribution_file.write(
            "# Attribution for the imported piece models\n"
            "\n"
            "The .glb files in this directory are derived from a third-party model.\n"
            "They were extracted, decimated and re-origined by\n"
            "`scripts/extract_chess_pieces.py`, but they remain a derivative work and\n"
            "the original licence still applies to them.\n"
            "\n"
            f"* **Title**   : {credits['title']}\n"
            f"* **Author**  : {credits['author']}\n"
            f"* **Licence** : {credits['license']}\n"
            f"* **Source**  : {credits['source']}\n"
            f"* **Originally exported by** : {credits['generator']}\n"
            f"* **Source file** : `{os.path.basename(source_path)}`\n"
            "\n"
            "## What still has to be done\n"
            "\n"
            "A CC-BY licence is satisfied by crediting the author wherever the work is\n"
            "used, not by recording it here. Before submitting:\n"
            "\n"
            "1. Credit the author in `README.md`, replacing the line stating that the\n"
            "   models are self-authored and need no attribution.\n"
            "2. Credit the author somewhere visible in the running application -- the\n"
            "   landing page is the natural place.\n"
            "3. Credit the author in the technical report, and update the section\n"
            "   arguing that asset sourcing was a dead end.\n"
            "\n"
            "The generated set in `../models/` carries none of these obligations and\n"
            "remains available as a fallback.\n"
        )
    return attribution_path


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

# What a full board holds, used to report the number that actually decides
# whether a set is usable in Duel Mode.
PIECES_ON_A_FULL_BOARD = {
    "pawn": 16, "rook": 4, "knight": 4, "bishop": 4, "queen": 2, "king": 2,
}

# The order pieces are reported in: shortest to tallest in a conventional set,
# which is also the order they appear in generate_chess_pieces.py.
PIECE_ORDER = ("pawn", "rook", "knight", "bishop", "queen", "king")


def parse_arguments():
    parser = argparse.ArgumentParser(
        description="Extract six web-optimised chess piece models from a downloaded chess set.",
    )
    parser.add_argument(
        "--source",
        required=True,
        help="path to the downloaded .glb containing a complete set-up chess board",
    )
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT_DIRECTORY,
        help="directory to write the six .glb files into",
    )
    parser.add_argument(
        "--preset",
        default="mobile",
        choices=sorted(DECIMATION_PRESETS.keys()),
        help=(
            "face budget: 'mobile' targets a full 32-piece board in AR (default), "
            "'high' suits Puzzle Mode and desktop, 'source' does not decimate"
        ),
    )
    parser.add_argument(
        "--king-height",
        type=float,
        default=KING_HEIGHT_IN_SQUARES,
        help=(
            "height of the king in board squares; the rest of the set is scaled "
            f"from it by the source's own proportions (default {KING_HEIGHT_IN_SQUARES})"
        ),
    )
    return parser.parse_args()


def main():
    arguments = parse_arguments()
    face_budgets = DECIMATION_PRESETS[arguments.preset]

    if not os.path.isfile(arguments.source):
        raise SystemExit(f"source model not found: {arguments.source}")
    os.makedirs(arguments.output, exist_ok=True)

    credits = read_source_credits(arguments.source)
    print(f"source   : {credits['title']} by {credits['author']}")
    print(f"licence  : {credits['license']}")
    print(f"preset   : {arguments.preset}")
    print(f"output   : {arguments.output}\n")

    scene = trimesh.load(arguments.source, process=False)
    members_by_node = group_geometry_into_pieces(scene)
    measurements = {
        node_name: measure_piece(scene, members)
        for node_name, members in members_by_node.items()
    }
    classification = classify_pieces(measurements)

    nodes_by_piece_type = defaultdict(list)
    for node_name, piece_type in classification.items():
        nodes_by_piece_type[piece_type].append(node_name)

    # One scale factor for the whole set, derived from the king, so the source's
    # proportions survive intact. See the module docstring.
    king_node = choose_instance_to_extract(
        nodes_by_piece_type["king"], measurements, members_by_node
    )
    source_king_height = measurements[king_node]["height"]
    scale_factor = arguments.king_height / source_king_height
    print(
        f"scale    : king {source_king_height:.2f} source units -> "
        f"{arguments.king_height:.2f} squares (x{scale_factor:.6f})\n"
    )

    header = f"{'piece':<8}{'source':>9}{'exported':>10}{'meshes':>8}{'height':>9}{'radius':>9}{'size':>9}"
    print(header)
    print("-" * len(header))

    total_source_faces = 0
    total_exported_faces = 0
    export_reports = {}

    for piece_type in PIECE_ORDER:
        node_name = choose_instance_to_extract(
            nodes_by_piece_type[piece_type], measurements, members_by_node
        )
        members = members_by_node[node_name]

        body_mesh = build_world_space_mesh(scene, members, wanted_accent=False)
        accent_mesh = build_world_space_mesh(scene, members, wanted_accent=True)
        if body_mesh is None:
            raise ValueError(f"{piece_type} ({node_name}) has no body mesh")

        source_faces = len(body_mesh.faces) + (len(accent_mesh.faces) if accent_mesh else 0)

        if face_budgets is not None:
            body_budget, accent_budget = allocate_face_budget(
                len(body_mesh.faces),
                len(accent_mesh.faces) if accent_mesh else 0,
                face_budgets[piece_type],
            )
            body_mesh = decimate_mesh(body_mesh, body_budget)
            if accent_mesh is not None:
                accent_mesh = decimate_mesh(accent_mesh, accent_budget)

        # Scale and re-origin the body and the accent together, so the accent
        # stays exactly where the artist put it relative to the body.
        piece_meshes = [mesh for mesh in (body_mesh, accent_mesh) if mesh is not None]
        for mesh in piece_meshes:
            mesh.apply_scale(scale_factor)

        piece_bounds = np.array([mesh.bounds for mesh in piece_meshes])
        lower_bounds = piece_bounds[:, 0, :].min(axis=0)
        upper_bounds = piece_bounds[:, 1, :].max(axis=0)
        recentre = [
            -(lower_bounds[0] + upper_bounds[0]) / 2.0,  # centre on X
            -lower_bounds[1],                            # base sits on y = 0
            -(lower_bounds[2] + upper_bounds[2]) / 2.0,  # centre on Z
        ]
        for mesh in piece_meshes:
            mesh.apply_translation(recentre)

        apply_material(body_mesh, "ChessPieceBody", IVORY_BASE_COLOUR, 0.05, 0.55)
        if accent_mesh is not None:
            apply_material(accent_mesh, "ChessPieceAccent", ACCENT_BASE_COLOUR, 0.85, 0.25)

        expected_height = measurements[node_name]["height"] * scale_factor
        model_path = os.path.join(arguments.output, f"{piece_type}.glb")
        export_piece(body_mesh, accent_mesh, model_path)
        report = verify_exported_model(model_path, expected_height)

        total_source_faces += source_faces
        total_exported_faces += report["faces"]
        export_reports[piece_type] = report

        print(
            f"{piece_type:<8}{source_faces:>9}{report['faces']:>10}{report['meshes']:>8}"
            f"{report['height']:>9.3f}{report['radius']:>9.3f}{report['kilobytes']:>8.1f}K"
        )

    attribution_path = write_attribution_file(arguments.output, credits, arguments.source)

    board_source_faces = sum(
        # The source's own per-piece face counts, before any decimation.
        measurements[choose_instance_to_extract(
            nodes_by_piece_type[piece_type], measurements, members_by_node
        )]["faces"] * count
        for piece_type, count in PIECES_ON_A_FULL_BOARD.items()
    )
    board_exported_faces = sum(
        export_reports[piece_type]["faces"] * count
        for piece_type, count in PIECES_ON_A_FULL_BOARD.items()
    )
    total_kilobytes = sum(report["kilobytes"] for report in export_reports.values())

    print("-" * len(header))
    print(
        f"{'six':<8}{total_source_faces:>9}{total_exported_faces:>10}"
        f"{'':>8}{'':>9}{'':>9}{total_kilobytes:>8.1f}K"
    )
    print(
        f"\nfull 32-piece board: {board_exported_faces:,} triangles "
        f"(down from {board_source_faces:,} in the source)"
    )
    print(f"attribution written to {attribution_path}")

    # The imported knight being shorter than the imported pawn is surprising
    # enough that it must be stated, or it reads as a bug in this script.
    if export_reports["knight"]["height"] < export_reports["pawn"]["height"]:
        print(
            "\nnote: the imported knight is shorter than the imported pawn "
            f"({export_reports['knight']['height']:.3f} vs "
            f"{export_reports['pawn']['height']:.3f} squares). That is the "
            "original artist's proportion, preserved deliberately."
        )

    relative_output = os.path.relpath(arguments.output, os.path.join(PROJECT_ROOT, "frontend"))
    print(
        "\nTo use this set, point MODEL_BASE_PATH in frontend/js/config.js at\n"
        f"  ./{relative_output.replace(os.sep, '/')}/\n"
        "The generated set in frontend/assets/models/ is left untouched."
    )


if __name__ == "__main__":
    main()
