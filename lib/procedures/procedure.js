/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var VError = require('verror');


function Procedure() {}
Procedure.prototype.summarize = function summarize() {};
Procedure.prototype.execute = function execute(options, cb) {
    cb(new VError({name: 'NotImplementedError'},
        this.constructor.name + '.execute() is not implemented'));
};


//---- exports

module.exports = {
    Procedure: Procedure
};
// vim: set softtabstop=4 shiftwidth=4:
