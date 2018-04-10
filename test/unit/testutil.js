/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */
'use strict';

const bunyan = require('bunyan');

function TestCommentStream(test) {
    this.test = test;
}

TestCommentStream.prototype.write = function write(rec) {
    this.test.comment(rec);
};

function createBunyanLogger(test) {
    return bunyan.createLogger(
        {name: 'unit',
         streams: [{type: 'raw',
                    stream: new TestCommentStream(test)}]});
}

module.exports = {
    createBunyanLogger: createBunyanLogger
};
