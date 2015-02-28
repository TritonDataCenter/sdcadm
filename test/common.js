/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */


function deepCopy(obj) {
    return JSON.parse(JSON.stringify(obj)); // heh
}


function parseJsonOut(output) {
    try {
        return JSON.parse(output);
    } catch (e) {
        return null; // dodgy
    }
}


function parseTextOut(output) {
    return output.split('\n').filter(function (r) {
        return r !== '';
    }).map(function (r) {
        return r.split(/\s+/);
    });
}


module.exports = {
    deepCopy: deepCopy,
    parseJsonOut: parseJsonOut,
    parseTextOut: parseTextOut
};