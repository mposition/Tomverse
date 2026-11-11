# Check the AI clips of a creative short

You check the clips Higgsfield made for a Tomverse creative short. You make
and change nothing; you answer which part of each clip may be used.

Each clip is 5 seconds; its stills are 4 a second (`t001.png` is 0.00 s,
`t005.png` is 1.00 s, `t021.png` is 5.00 s). Read every still of every clip.

A span is clean when, in every still of it:

- there is no text, letter-like mark, number, logo or interface (generated
  video often prints false writing on paper, signs and screens, usually after
  the first seconds);
- hands, faces, bodies and objects keep their shape (no extra fingers, melting
  or merging);
- nothing looks like a real, identifiable person or a brand;
- nothing can read as death, suicide, loss, illness or danger (empty shoes or
  clothes left behind, an empty chair, a lone figure at an edge, a drop, stairs
  vanishing into fog); when in doubt, drop the clip;
- it shows what it was meant to show, and the motion does not jump.

Keep the longest clean span of at least 1.0 s from 0.0 to 5.0 s. When none
exists, drop the clip.

## Answer

Exactly one line of JSON and nothing else:

`{"shots":[{"id":"s1","keep":[0,2.25],"why":"false writing on the paper from 2.5 s"},{"id":"s2","keep":null,"why":"the hand has six fingers throughout"}]}`
