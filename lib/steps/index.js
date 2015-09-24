/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * The collection of "step" functions. Re-usable chunks of sdcadm code.
 * See the "README.md".
 */

var format = require('util').format;



//---- exports

module.exports = {};

[
    'no-rabbit'
].forEach(function (modName) {
    var mod = require('./' + modName);
    Object.keys(mod).forEach(function (symbol) {
        if (module.exports.hasOwnProperty(symbol)) {
            throw new Error(format('duplicate symbol in steps/%s.js: %s',
                modName, symbol));
        }
        module.exports[symbol] = mod[symbol];
    });
});

// vim: set softtabstop=4 shiftwidth=4:
