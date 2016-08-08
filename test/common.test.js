/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

var test = require('tape').test;
var common = require('../lib/common.js');

test('safeCycles', function (t) {
    var a = {
        foo: {
            bar: null
        }
    };
    a.foo.bar = a;

    t.throws(function () {
        JSON.stringify(a);
    }, TypeError);

    t.doesNotThrow(function () {
        JSON.stringify(a, common.safeCycles());
    }, TypeError);

    t.end();
});
