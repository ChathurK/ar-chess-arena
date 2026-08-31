/**
 * roomCodes.js
 * ============
 * Generates the short codes players read out to each other to join a duel.
 *
 * The whole design constraint is that a code has to survive being spoken
 * across a room, or typed from a photo, without ambiguity:
 *
 *   • four characters — short enough to say in one breath;
 *   • no 0/O, 1/I/L, 5/S, 2/Z — the pairs people reliably confuse;
 *   • upper case only, and the join handler upper-cases whatever is typed, so
 *     "b7kd" and "B7KD" are the same room.
 *
 * The remaining alphabet still gives 28^4 ≈ 614,000 codes, which is far more
 * than a student project will ever hold at once — but generation still checks
 * for a collision rather than assuming, because a silent collision would drop
 * two strangers into the same game.
 */

const UNAMBIGUOUS_CHARACTERS = 'ABCDEFGHJKMNPQRTUVWXY346789';
const ROOM_CODE_LENGTH = 4;
const MAXIMUM_GENERATION_ATTEMPTS = 50;

/**
 * Produce a room code that is not already in use.
 *
 * @param {(code: string) => boolean} isCodeTaken Asked about each candidate.
 * @returns {string|null} A free code, or null if the space is somehow full —
 *   which the caller must handle rather than looping forever.
 */
function generateRoomCode(isCodeTaken) {
  for (let attempt = 0; attempt < MAXIMUM_GENERATION_ATTEMPTS; attempt += 1) {
    let candidateCode = '';
    for (let characterIndex = 0; characterIndex < ROOM_CODE_LENGTH; characterIndex += 1) {
      candidateCode +=
        UNAMBIGUOUS_CHARACTERS[Math.floor(Math.random() * UNAMBIGUOUS_CHARACTERS.length)];
    }
    if (!isCodeTaken(candidateCode)) {
      return candidateCode;
    }
  }
  return null;
}

/**
 * Tidy up whatever the joining player typed.
 *
 * Returns null for anything that could not possibly be a code, so the caller
 * can reject it before touching the room map.
 */
function normaliseRoomCode(rawCode) {
  if (typeof rawCode !== 'string') {
    return null;
  }
  const normalised = rawCode.trim().toUpperCase();
  if (normalised.length !== ROOM_CODE_LENGTH) {
    return null;
  }
  for (const character of normalised) {
    if (!UNAMBIGUOUS_CHARACTERS.includes(character)) {
      return null;
    }
  }
  return normalised;
}

module.exports = {
  ROOM_CODE_LENGTH,
  UNAMBIGUOUS_CHARACTERS,
  generateRoomCode,
  normaliseRoomCode,
};
