/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * A class to capture all/most output on the CLI. Typically the sdcadm CLI
 * will have an instanced of this at `this.ui`. Sdcadm code should use that
 * to write output for the user.
 *
 * Backwards compat: Not all sdcadm code has been migrated to use this. There
 * is still a lot of usage of a `progress` function and `ProgressBar`s.
 *
 * Usage in sdcadm code:
 *
 * - get the `<cli>.ui` object
 * - `ui.info(...)` for printf-style message output to stdout
 * - `ui.error(...)` for printf-style error message output to stdout. If on
 *   a TTY, this is colored red. Otherwise it is the same as `ui.info`.
 * - To use a progress bar:kkkkk
 *      - call `ui.barStart({name: 'NAME', size: SIZE})`
 *      - call `ui.barAdvance(N)` to advance progress
 *      - call `ui.barEnd()` when complete.
 *   These methods know to avoid using a progress bar if output is not to a
 *   TTY. `ui.info` and `ui.error` know to use `<bar>.log` when a progress bar
 *   is active.
 */

'use strict';

var format = require('util').format;

var assert = require('assert-plus');
var ProgressBar = require('progbar').ProgressBar;
var VError = require('verror');


// ---- internal support stuff

// http://en.wikipedia.org/wiki/ANSI_escape_code#graphics
// Suggested colors (some are unreadable in common cases):
// - Good: cyan, yellow (limited use), bold, green, magenta, red
// - Bad: grey (same color as background on Solarized Dark theme from
//   <https://github.com/altercation/solarized>, see issue #160)
var colors = {
    'bold': [1, 22],
    'italic': [3, 23],
    'underline': [4, 24],
    'inverse': [7, 27],
    'white': [37, 39],
    'grey': [90, 39],
    'black': [30, 39],
    'blue': [34, 39],
    'cyan': [36, 39],
    'green': [32, 39],
    'magenta': [35, 39],
    'red': [31, 39],
    'yellow': [33, 39]
};

function stylizeWithColor(str, color) {
    if (!str)
        return '';
    var codes = colors[color];
    if (codes) {
        return '\x1b[' + codes[0] + 'm' + str + '\x1b[' + codes[1] + 'm';
    } else {
        return str;
    }
}

function stylizeWithoutColor(str, _color) {
    return str;
}



// ---- UI

function UI(opts) {
    assert.object(opts.log, 'opts.log');
    assert.optionalBool(opts.color, 'opts.color');

    this.log = opts.log.child({ui: true}, true);

    // We support ANSI escape code coloring (currently just used for `ui.error`)
    // if writing to a TTY. Use `SDCADM_NO_COLOR=1` envvar to disable.
    var color = opts.color;
    if (color === null || color === undefined) {
        if (process.env.SDCADM_NO_COLOR &&
                process.env.SDCADM_NO_COLOR.length > 0) {
            color = false;
        } else {
            color = process.stdout.isTTY;
        }
    }
    this._stylize = (color ? stylizeWithColor : stylizeWithoutColor);
}

// Temporary convenience function for parts of sdcadm that still use the
// old `progress` function for emitting text to the user.
UI.prototype.progressFunc = function progressFunc() {
    return this.info.bind(this);
};

UI.prototype.info = function info() {
    var msgArgs = Array.prototype.slice.call(arguments);
    var msg = format.apply(null, msgArgs);
    this.log.debug(msg);
    if (this._bar) {
        this._bar.log(msg);
    } else  {
        console.log(msg);
    }
};

UI.prototype.error = function error() {
    var msgArgs = Array.prototype.slice.call(arguments);
    var msg = format.apply(null, msgArgs);
    this.log.debug(msg);
    var styled = this._stylize(msg, 'red');
    if (this._bar) {
        this._bar.log(styled);
    } else  {
        console.log(styled);
    }
};

// Start a progress bar.
//
// This will be a no-op for cases where a progress bar is inappropriate
// (e.g. if stderr is not a TTY).
UI.prototype.barStart = function barStart(opts) {
    assert.string(opts.name, 'opts.name');
    assert.finite(opts.size, 'opts.size');

    if (this._bar) {
        throw new VError('another progress bar (%s) is currently active',
            this._bar.filename);
    } else if (process.stderr.isTTY) {
        this._bar = new ProgressBar({
            filename: opts.name,
            size: opts.size,
            // ProgressBar began life assuming it was progress for a file
            // download. Hence `*file*name`. To avoid it appending size suffixes
            // like "KB" and "MB" we need to explicitly `bytes: false`.
            bytes: false
        });
        this._bar.draw();
    }
};

UI.prototype.barEnd = function barEnd() {
    if (this._bar) {
        this._bar.end();
        delete this._bar;
    }
};

UI.prototype.barAdvance = function barAdvance(n) {
    if (this._bar) {
        this._bar.advance(n);
    }
};


// --- exports

module.exports = UI;
