/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The startup/setup logic for the about:nosy extension as a whole.  We:
 *
 * - Create the "about:nosy" handler which gets mapped to data/aboutnosy.html,
 *    a page that runs without any privileges but does get a comm bridge.
 * - Create a pagemod handler for about:nosy that establishes a comm bridge
 *    that is how it requests and gets its data.  The design intent is to both
 *    allow this mechanism to work under electrolysis and to be able to send
 *    the data over the wire to a completely different machine, etc.
 *
 * Important notes:
 *
 * - Data collection only occurs when an "about:nosy" page is being displayed.
 **/

const $protocol = require('./jetpack-protocol/index');

