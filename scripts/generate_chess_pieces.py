"""
generate_chess_pieces.py
========================
Procedurally generates the six unique chess piece geometries used by AR Chess
Arena and exports each one as its own small .glb file.

WHY PROCEDURAL RATHER THAN DOWNLOADED ASSETS
--------------------------------------------
Sourcing thematically-specific 3D models from asset sites turned out to be a
dead end on an earlier project (downloads behind authentication, no reliable
no-attribution CC0 source). Chess pieces, however, are almost all solids of
revolution, so generating them from a 2D silhouette profile spun around the
vertical axis produces genuinely decent shapes with zero licensing risk and
fully self-authored geometry.

DESIGN CONVENTIONS (relied upon by the frontend, do not change casually)
------------------------------------------------------------------------
* Units          : 1.0 model unit == the width of one board square.
* Up axis        : +Y (glTF convention).
* Facing         : +Z (only visually meaningful for the knight).
* Origin         : the exact centre of the piece's base, so the frontend can
                   position a piece by simply setting its position to the
                   centre of a square with y = board surface height.
* Colour         : a single neutral ivory PBR material. The frontend tints
                   each piece at runtime (warm ivory for White, dark charcoal
                   for Black), which is why only six files are needed, not
                   twelve.

Run:  python3 scripts/generate_chess_pieces.py
Out:  frontend/assets/models/{pawn,rook,knight,bishop,queen,king}.glb
"""

import math
import os

import numpy as np
import trimesh

# --------------------------------------------------------------------------
# Output configuration
# --------------------------------------------------------------------------

SCRIPT_DIRECTORY = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIRECTORY)
MODEL_OUTPUT_DIRECTORY = os.path.join(PROJECT_ROOT, "frontend", "assets", "models")

# Neutral ivory. Deliberately NOT pure white or black: the runtime tint
# multiplies/overrides this, and a neutral base reads correctly for both sides.
IVORY_BASE_COLOUR = [232, 224, 208, 255]

# Number of radial segments used when revolving a silhouette. 40 keeps the
# pieces smooth enough to look intentional while staying tiny on the wire
# (each exported .glb lands in the low tens of kilobytes).
REVOLUTION_SEGMENTS = 40

# Target height of each piece, expressed in board squares. These ratios follow
# a real chess set closely enough that the pieces are instantly identifiable
# by relative height alone, which matters a lot at phone-screen AR scale.
TARGET_PIECE_HEIGHTS = {
    "pawn": 0.50,
    "rook": 0.58,
    "knight": 0.66,
    "bishop": 0.72,
    "queen": 0.84,
    "king": 0.94,
}

# A piece must never visually spill onto its neighbouring squares, so its
# widest point is clamped to slightly under half a square.
MAXIMUM_PIECE_RADIUS = 0.40


# --------------------------------------------------------------------------
# Geometry helpers
# --------------------------------------------------------------------------

def build_arc_profile_points(centre_height, radius, start_degrees, end_degrees, point_count):
    """
    Return points along a circular arc for use inside a revolution profile.

    Used for rounded piece tops (a pawn's head, a bishop's tip). Each returned
    point is an (radius_from_axis, height) pair, which is the format
    trimesh.creation.revolve expects.
    """
    arc_points = []
    for step_index in range(point_count):
        interpolation = step_index / (point_count - 1)
        angle_degrees = start_degrees + (end_degrees - start_degrees) * interpolation
        angle_radians = math.radians(angle_degrees)
        arc_points.append(
            (radius * math.cos(angle_radians), centre_height + radius * math.sin(angle_radians))
        )
    return arc_points


def revolve_silhouette(profile_points):
    """
    Spin a 2D silhouette around the vertical axis into a solid mesh.

    trimesh revolves around its Z axis, so the result is rotated afterwards to
    make +Y the up axis (the glTF convention the frontend expects).
    """
    profile_array = np.array(profile_points, dtype=np.float64)

    # A profile whose height ever decreases would fold the surface back on
    # itself and produce self-intersecting geometry, so catch that here rather
    # than discovering it as a rendering artefact on a phone.
    height_differences = np.diff(profile_array[:, 1])
    if np.any(height_differences < -1e-9):
        raise ValueError("Revolution profile heights must never decrease")

    revolved_mesh = trimesh.creation.revolve(profile_array, sections=REVOLUTION_SEGMENTS)
    revolved_mesh.apply_transform(
        trimesh.transformations.rotation_matrix(-math.pi / 2.0, [1, 0, 0])
    )
    return revolved_mesh


def make_box(extents, position, rotation_degrees_about_x=0.0):
    """Create an axis-aligned (optionally X-tilted) box centred at `position`."""
    box_mesh = trimesh.creation.box(extents=extents)
    if rotation_degrees_about_x:
        box_mesh.apply_transform(
            trimesh.transformations.rotation_matrix(
                math.radians(rotation_degrees_about_x), [1, 0, 0]
            )
        )
    box_mesh.apply_translation(position)
    return box_mesh


def make_sphere(radius, position):
    """Create a low-poly sphere centred at `position`."""
    sphere_mesh = trimesh.creation.icosphere(subdivisions=2, radius=radius)
    sphere_mesh.apply_translation(position)
    return sphere_mesh


def make_upright_cone(radius, height, base_height, angle_around_axis_degrees, distance_from_axis):
    """
    Create an upright cone standing on a circle around the vertical axis.

    Used for the spikes of the queen's crown.
    """
    cone_mesh = trimesh.creation.cone(radius=radius, height=height, sections=12)
    cone_mesh.apply_transform(
        trimesh.transformations.rotation_matrix(-math.pi / 2.0, [1, 0, 0])
    )
    # Sit the cone's base exactly on `base_height` regardless of how trimesh
    # happens to centre its primitives.
    cone_mesh.apply_translation([0.0, base_height - cone_mesh.bounds[0][1], 0.0])
    angle_radians = math.radians(angle_around_axis_degrees)
    cone_mesh.apply_translation(
        [
            distance_from_axis * math.cos(angle_radians),
            0.0,
            distance_from_axis * math.sin(angle_radians),
        ]
    )
    return cone_mesh


def finalise_piece(piece_parts, target_height):
    """
    Combine a piece's parts, normalise its size and place its origin.

    Steps, in order:
      1. concatenate every part into a single mesh,
      2. scale uniformly so the piece is exactly `target_height` tall,
      3. shrink further if the piece is wider than a square can hold,
      4. move it so the origin sits at the centre of its base.
    """
    combined_mesh = trimesh.util.concatenate(piece_parts)

    current_height = combined_mesh.bounds[1][1] - combined_mesh.bounds[0][1]
    combined_mesh.apply_scale(target_height / current_height)

    horizontal_distances = np.sqrt(
        combined_mesh.vertices[:, 0] ** 2 + combined_mesh.vertices[:, 2] ** 2
    )
    widest_radius = float(horizontal_distances.max())
    if widest_radius > MAXIMUM_PIECE_RADIUS:
        combined_mesh.apply_scale(MAXIMUM_PIECE_RADIUS / widest_radius)

    lower_bounds, upper_bounds = combined_mesh.bounds
    combined_mesh.apply_translation(
        [
            -(lower_bounds[0] + upper_bounds[0]) / 2.0,  # centre on X
            -lower_bounds[1],                            # base sits on y = 0
            -(lower_bounds[2] + upper_bounds[2]) / 2.0,  # centre on Z
        ]
    )

    combined_mesh.visual = trimesh.visual.TextureVisuals(
        material=trimesh.visual.material.PBRMaterial(
            name="ChessPieceIvory",
            baseColorFactor=IVORY_BASE_COLOUR,
            metallicFactor=0.05,
            roughnessFactor=0.55,
        )
    )
    return combined_mesh


# --------------------------------------------------------------------------
# The six pieces
# --------------------------------------------------------------------------

def build_pawn():
    """Flared base, slim stem, collar, spherical head."""
    head_radius = 0.150
    neck_radius = 0.105
    neck_top_height = 0.360
    # Place the head sphere so its surface meets the neck exactly, avoiding a
    # visible step where the two shapes join.
    head_centre_height = neck_top_height + math.sqrt(head_radius ** 2 - neck_radius ** 2)
    head_start_degrees = -math.degrees(math.acos(neck_radius / head_radius))

    profile = [
        (0.000, 0.000),
        (0.300, 0.000),
        (0.300, 0.040),
        (0.270, 0.070),
        (0.160, 0.120),
        (0.115, 0.260),
        (0.175, 0.300),
        (0.200, 0.330),
        (0.150, 0.355),
        (neck_radius, neck_top_height),
    ]
    profile += build_arc_profile_points(head_centre_height, head_radius, head_start_degrees, 90.0, 12)
    return [revolve_silhouette(profile)]


def build_rook():
    """Straight castle body topped with a ring of crenellations."""
    battlement_base_height = 0.600
    battlement_top_height = 0.700

    profile = [
        (0.000, 0.000),
        (0.320, 0.000),
        (0.320, 0.050),
        (0.285, 0.090),
        (0.215, 0.145),
        (0.200, 0.400),
        (0.245, 0.450),
        (0.290, 0.500),
        (0.290, battlement_base_height),
        (0.000, battlement_base_height),
    ]
    rook_parts = [revolve_silhouette(profile)]

    # Six blocks spaced evenly around the rim read clearly as battlements even
    # on a small phone screen, where more blocks would blur together.
    for battlement_index in range(6):
        angle_radians = math.radians(battlement_index * 60.0)
        rook_parts.append(
            make_box(
                extents=[0.130, battlement_top_height - battlement_base_height, 0.090],
                position=[
                    0.215 * math.cos(angle_radians),
                    (battlement_base_height + battlement_top_height) / 2.0,
                    0.215 * math.sin(angle_radians),
                ],
            )
        )
    return rook_parts


def build_knight():
    """
    The only piece that is not a solid of revolution.

    A recognisable horse is well beyond primitive assembly, so this builds an
    angled head-and-neck silhouette from boxes on a turned base. It only has to
    be unmistakably different from the other five at a glance, which the
    forward-leaning profile achieves.
    """
    base_profile = [
        (0.000, 0.000),
        (0.300, 0.000),
        (0.300, 0.050),
        (0.265, 0.090),
        (0.185, 0.140),
        (0.170, 0.220),
        (0.000, 0.220),
    ]
    knight_parts = [revolve_silhouette(base_profile)]

    # Neck: a slab tilted forward so the piece visibly "looks" along +Z. Its
    # lower end is deliberately sunk into the turned base so the two parts read
    # as one solid rather than a slab balanced on a disc.
    knight_parts.append(
        make_box(extents=[0.200, 0.420, 0.180], position=[0.0, 0.400, -0.030],
                 rotation_degrees_about_x=20.0)
    )
    # Skull and muzzle.
    knight_parts.append(make_box(extents=[0.190, 0.180, 0.310], position=[0.0, 0.605, 0.055]))
    knight_parts.append(make_box(extents=[0.150, 0.130, 0.150], position=[0.0, 0.545, 0.215]))
    # Ears.
    for ear_offset_x in (-0.060, 0.060):
        knight_parts.append(
            make_box(extents=[0.045, 0.110, 0.045], position=[ear_offset_x, 0.725, -0.050])
        )
    return knight_parts


def build_bishop():
    """Tall tapered mitre with a collar and a small ball finial."""
    profile = [
        (0.000, 0.000),
        (0.300, 0.000),
        (0.300, 0.045),
        (0.265, 0.080),
        (0.165, 0.130),
        (0.128, 0.300),
        (0.185, 0.340),
        (0.212, 0.372),
        (0.160, 0.400),
        (0.138, 0.420),
        (0.180, 0.470),
        (0.165, 0.560),
        (0.105, 0.670),
        (0.050, 0.730),
        (0.020, 0.756),
        (0.000, 0.762),
    ]
    return [revolve_silhouette(profile), make_sphere(radius=0.058, position=[0.0, 0.800, 0.0])]


def build_queen():
    """Turned body opening into a spiked coronet with a ball at its centre."""
    crown_rim_height = 0.700
    profile = [
        (0.000, 0.000),
        (0.340, 0.000),
        (0.340, 0.050),
        (0.300, 0.090),
        (0.195, 0.150),
        (0.152, 0.360),
        (0.205, 0.400),
        (0.232, 0.440),
        (0.190, 0.472),
        (0.172, 0.505),
        (0.222, 0.600),
        (0.262, crown_rim_height),
        (0.000, crown_rim_height),
    ]
    queen_parts = [revolve_silhouette(profile)]

    # Eight spikes around the rim: enough to read as a crown from any angle
    # without turning into a blob.
    for spike_index in range(8):
        queen_parts.append(
            make_upright_cone(
                radius=0.048,
                height=0.110,
                base_height=crown_rim_height - 0.010,
                angle_around_axis_degrees=spike_index * 45.0,
                distance_from_axis=0.210,
            )
        )
    queen_parts.append(make_sphere(radius=0.070, position=[0.0, crown_rim_height + 0.050, 0.0]))
    return queen_parts


def build_king():
    """Tallest turned body, finished with the traditional cross finial."""
    profile = [
        (0.000, 0.000),
        (0.345, 0.000),
        (0.345, 0.055),
        (0.305, 0.095),
        (0.205, 0.155),
        (0.162, 0.400),
        (0.215, 0.442),
        (0.243, 0.482),
        (0.202, 0.515),
        (0.184, 0.548),
        (0.232, 0.645),
        (0.252, 0.725),
        (0.185, 0.765),
        (0.150, 0.785),
        (0.000, 0.785),
    ]
    king_parts = [revolve_silhouette(profile)]
    # Cross finial: one upright bar crossed by a shorter horizontal bar.
    king_parts.append(make_box(extents=[0.060, 0.215, 0.060], position=[0.0, 0.885, 0.0]))
    king_parts.append(make_box(extents=[0.170, 0.060, 0.060], position=[0.0, 0.905, 0.0]))
    return king_parts


PIECE_BUILDERS = {
    "pawn": build_pawn,
    "rook": build_rook,
    "knight": build_knight,
    "bishop": build_bishop,
    "queen": build_queen,
    "king": build_king,
}


# --------------------------------------------------------------------------
# Export and verification
# --------------------------------------------------------------------------

def verify_exported_model(model_path, expected_height):
    """
    Reload an exported .glb and sanity-check it before it is trusted.

    A model that exports without error can still be unusable (NaN vertices, a
    wildly wrong scale, an origin in the wrong place), and every one of those
    failures is far cheaper to catch here than on a phone in AR.
    """
    reloaded_mesh = trimesh.load(model_path, force="mesh")

    assert np.isfinite(reloaded_mesh.vertices).all(), "model contains NaN or infinite vertices"
    assert len(reloaded_mesh.faces) > 0, "model contains no faces"

    lower_bounds, upper_bounds = reloaded_mesh.bounds
    actual_height = upper_bounds[1] - lower_bounds[1]
    assert abs(actual_height - expected_height) < 0.02, (
        f"height {actual_height:.3f} does not match the requested {expected_height:.3f}"
    )
    assert abs(lower_bounds[1]) < 1e-4, "the base of the model does not sit on y = 0"

    widest_radius = float(
        np.sqrt(reloaded_mesh.vertices[:, 0] ** 2 + reloaded_mesh.vertices[:, 2] ** 2).max()
    )
    assert widest_radius <= MAXIMUM_PIECE_RADIUS + 1e-3, "model is wider than one board square"

    return {
        "faces": len(reloaded_mesh.faces),
        "height": actual_height,
        "radius": widest_radius,
        "watertight": reloaded_mesh.is_watertight,
        "kilobytes": os.path.getsize(model_path) / 1024.0,
    }


def main():
    os.makedirs(MODEL_OUTPUT_DIRECTORY, exist_ok=True)

    print(f"trimesh {trimesh.__version__} -> {MODEL_OUTPUT_DIRECTORY}\n")
    print(f"{'piece':<8}{'faces':>8}{'height':>9}{'radius':>9}{'tight':>7}{'size':>9}")
    print("-" * 50)

    for piece_name, build_piece in PIECE_BUILDERS.items():
        target_height = TARGET_PIECE_HEIGHTS[piece_name]
        finished_mesh = finalise_piece(build_piece(), target_height)

        model_path = os.path.join(MODEL_OUTPUT_DIRECTORY, f"{piece_name}.glb")
        finished_mesh.export(model_path)

        report = verify_exported_model(model_path, target_height)
        print(
            f"{piece_name:<8}{report['faces']:>8}{report['height']:>9.3f}"
            f"{report['radius']:>9.3f}{str(report['watertight']):>7}{report['kilobytes']:>8.1f}K"
        )

    print("\nAll six pieces exported and verified.")


if __name__ == "__main__":
    main()
