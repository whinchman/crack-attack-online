# Attribution

Crack Attack! is Copyright (C) 2000-2006 by Daniel R. Nelson, R. Andrew
Sayman, Kevin Webb, Stephan Beyer, Dennis Lubert, Wolfgang Klier, Till
Schuberth, Bjørn Lindeijer, and other contributors.

This browser derivative uses gameplay behavior studied from Crack Attack!
1.1.15-cvs at upstream commit
`a39f5d1009bb4a25d0115d20a60e3d9d84b0072c`. It redistributes original logo,
garbage, message, countdown, sign, block-mesh, and font-derived artwork in
browser-compatible formats.

The original source is available at:
https://github.com/gnu-lorien/crack-attack

The derivative is licensed under the GNU General Public License, version 2 or,
at your option, any later version. See `COPYING`.

## This fork

Modified in September 2026 by Will Hinchman, in a fork of
leifkb/crack-attack-browser, to add online two-player support. Changed files
include `app/game/engine.ts` (attack buffering, opponent level lights),
`app/game/renderer.ts` (the opponent light column) and
`app/game/CrackAttackGame.tsx` (match wiring and overlays), plus the new
`app/net/` and `relay/` directories.
The network model (shared seed for fairness, per-peer simulation, 32-tick
garbage/level-light exchange) is reproduced from the original Crack Attack!
`src/Communicator.cxx` by Daniel Nelson, GPLv2-or-later.
