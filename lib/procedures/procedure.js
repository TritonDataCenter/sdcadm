/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

function Procedure() {}
Procedure.prototype.summarize = function summarize() {};
Procedure.prototype.execute = function execute(_options, _cb) {};

// --- exports

module.exports = {
    Procedure: Procedure
};
// vim: set softtabstop=4 shiftwidth=4:
