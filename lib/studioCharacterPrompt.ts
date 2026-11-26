/**
 * Character maker presets and the brief sent with the user's portrait.
 *
 * A stylised preset is a medium: the whole character, face included, is made in
 * it, since a brief that asks to preserve the face returns a photographed face on
 * a drawn body. A photoreal preset is a film role. Its direction names the costume, the
 * signature prop, the setting and the genre's own light and grade, because a
 * role described only by a pose and a lamp comes back as an extra in a cloak.
 * The portrait travels alone as the reference: the brief carries the look.
 */
export const STUDIO_CHARACTER_PRESETS = [
  { id: "fantasy", label: "fantasyCharacter", artwork: "character-fantasy.webp", photoreal: true,
    direction: "A fantasy mage casting a spell at night in an ancient forest. Deep hood raised over the hair, heavy forest-green robe embroidered with gold constellations, a gnarled staff with a lit brass lantern hanging from its crook in one hand, the other hand lifted as a ribbon of golden sparks spirals from the palm. Warm lantern and spell light on the face against cold blue moonlit mist; high-fantasy film grade." },
  { id: "knight", label: "knightCharacter", artwork: "character-knight.webp", photoreal: true,
    direction: "A royal knight standing guard on a castle battlement at dawn. Polished plate armour engraved with a gold lion crest, a heavy crimson cape lifting in the wind, both gauntleted hands resting on the pommel of a longsword planted point-down. Banners and stone towers behind; cool overcast light with a warm rim from the rising sun, historical-epic film grade." },
  { id: "pilot", label: "pilotCharacter", artwork: "character-pilot.webp", photoreal: true,
    direction: "A starship pilot in the cockpit during a deep-space approach. White and cobalt flight suit with mission patches and a metal neck ring, one gloved hand on the throttle, a helmet with a gold visor resting on the console, banks of switches and glowing instruments all around. A ringed planet fills the canopy; cold planet light on one cheek and amber instrument glow on the other, hard science-fiction film grade." },
  { id: "courier", label: "courierCharacter", artwork: "character-courier.webp", photoreal: true,
    direction: "A cyberpunk courier rushing a delivery across a rain-slick elevated walkway at night, glancing back over one shoulder. Glossy purple techwear jacket with glowing seam piping, a translucent visor pushed up into the hair, one hand gripping the strap of a hard-shell delivery pack with a blinking status light. Towering holographic signs in magenta and cyan reflect on wet skin, jacket and railings; neon cyberpunk film grade." },
  { id: "explorer", label: "explorerCharacter", artwork: "character-explorer.webp", photoreal: true,
    direction: "A desert explorer discovering a lost temple in an ochre canyon at golden hour. Sweat-stained wide-brimmed hat with brass goggles on the band, sand-coloured linen scarf, a leather satchel strap across the chest, one hand holding up a half-unrolled ancient map, the carved temple facade towering behind. Low sun rakes across the face under the hat brim through drifting dust; classic adventure-film grade." },
  { id: "detective", label: "detectiveCharacter", artwork: "character-detective.webp", photoreal: true,
    direction: "A 1940s film-noir private detective under a single streetlamp on a rain-soaked night street. Battered fedora tilted low so its brim shadows one eye, worn trench coat with the collar turned up, one hand tipping the brim and a case file tucked under the arm, a wary sidelong stare. Near-monochrome classic noir cinematography: deep blacks, one hard side light, slatted shadows across the wall behind, silver rain and wet reflections, only a faint sodium tint." },
  { id: "pirate", label: "pirateCharacter", artwork: "character-pirate.webp", photoreal: true,
    direction: "A pirate captain at the helm of a galleon in a rising storm. Feathered tricorne, weathered burgundy brocade coat with gold buttons, a gold earring and a cutlass at the belt, one hand gripping the ship's wheel, a sly fearless grin. Rigging, torn sails and a dark swelling sea behind, spray in the air; low stormlight breaking through the clouds, swashbuckler film grade." },
  { id: "fairy", label: "fairyCharacter", artwork: "character-fairy.webp", photoreal: true,
    direction: "A woodland fairy in an enchanted forest glade at dusk. Translucent iridescent wings spread wide behind the shoulders, a crown of wildflowers and twigs, a moss-and-leaf tunic, slightly pointed ears, one hand lifted as a firefly lands on a fingertip, a small curious smile. Floating motes of light and shafts of green-gold sun through the trees glow on the face and wings; fairy-tale film grade." },
  { id: "anime", label: "animeCharacter", artwork: "preset-anime.webp",
    direction: "An original hand-drawn animation film protagonist. Clean cel-shaded face with simple expressive eyes and flat colour shapes, wind-tossed hair, a long red scarf streaming behind and a traveller's jacket, standing on a hillside above the sea under towering painted cumulus clouds. Soft watercolour background; classic 2D feature-animation look." },
  { id: "3d", label: "threeDCharacter", artwork: "preset-3d.webp",
    direction: "A stylised 3D animated-film character. Large expressive eyes, simplified rounded features, smooth sculpted hair, soft skin shading and a tactile knitted sweater, in a playful confident pose on a warm studio set with soft key and rim light. Feature-animation render look." },
  { id: "comic", label: "comicHeroCharacter", artwork: "character-comic.webp",
    direction: "An original golden-age comic-book superhero. The face is drawn like the rest of the page: a few bold brush-ink contour lines, flat skin colour with one halftone shadow shape, simplified heroic features and a confident grin, never a photograph with a filter. Scarlet and navy suit with a cape and chest emblem, fists on hips in a heroic stance before a yellow sunburst. Vintage printed-comic look." },
  { id: "pixel", label: "pixelCharacter", artwork: "character-pixel.webp",
    direction: "A 16-bit pixel-art RPG hero portrait, drawn as a low-resolution sprite and enlarged: about 64 big square pixels across the frame, the face reduced to a few flat skin-tone blocks with two-pixel eyes and a short line for the mouth, hard stair-stepped outlines, a limited 16-colour palette and no smooth gradients. Embroidered teal hood and cloak, a bedroll backpack and a staff, pixel mountains and a castle behind. Classic console role-playing game look." },
  { id: "paper", label: "paperCharacter", artwork: "character-paper.webp",
    direction: "A cut-paper collage character. Face, hair and clothes are layered sheets of coloured cardstock with visible cut edges and soft shadows between the layers, simple cut shapes for eyes and smile, a bright festive outfit, a geometric paper sun and hills behind. Handmade paper-craft look." },
  { id: "felt", label: "feltCharacter", artwork: "character-felt.webp",
    direction: "A needle-felted wool puppet photographed for stop-motion. Round felt head with small bead eyes and a stitched smile, wool-roving hair, a chunky coral knitted sweater and a little shoulder bag, fuzzy fibres visible everywhere, a soft blue felt backdrop. Handmade stop-motion puppet look." },
  { id: "chibi", label: "chibiCharacter", artwork: "character-chibi.webp",
    direction: "A 2D super-deformed chibi mascot. Oversized head on a tiny body, huge sparkling eyes, a tiny simple nose and mouth, clean line art with flat pastel cel shading, a cheerful pose with one hand making a peace sign, a peach and pink background with stars and hearts. Cute mascot illustration look." },
] as const;

export type StudioCharacterPreset = (typeof STUDIO_CHARACTER_PRESETS)[number];
export type StudioCharacterPresetId = StudioCharacterPreset["id"];

export function studioCharacterPrompt(preset: StudioCharacterPreset) {
  const brief = "photoreal" in preset ? [
    "Cast the person in the reference as the lead of this film. Likeness comes first: keep this person's face width and fullness, brows, eye shape, nose, lips, jaw, hairline, hair colour, skin colouring and any facial hair exactly, at their real age; never slim, age or idealise the face.",
    "Shoot one cinematic film still from scratch. The reference gives identity only: its frontal pose, blank expression, flat lighting, plain clothes and background are all replaced. Turn the head three-quarter, act the moment with the eyes and mouth, and light the face with the scene's own key light, shadows and colour cast so skin, neck, hands, wardrobe and set share one lens, exposure and grade.",
    "The role and genre must read at a glance: commit fully to the costume, signature prop, setting and the genre's lighting and colour grade.",
    "Compose a square frame from the chest up with no text or watermark.",
  ] : [
    "Redesign the person in the reference as a character made entirely in this medium. Nothing photographic survives: the face, hair, hands and clothes are all drawn, modelled or crafted in the medium's own shapes, line and texture.",
    "Keep them recognisable through design, not realism: translate this person's face shape and fullness, hairstyle and hairline, brows, eye shape, and any glasses or facial hair into the medium's simplified features.",
    "Give the character the costume, pose and expression of the scene; the reference's plain clothes, frontal pose and background are replaced.",
    "Compose a square portrait with no text or watermark.",
  ];
  return [...brief, `Scene: ${preset.direction}`].join(" ");
}
