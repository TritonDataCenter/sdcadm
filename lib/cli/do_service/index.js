/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * 'sdcadm service ...'
 */

var util = require('util');

var cmdln = require('cmdln');
var Cmdln = cmdln.Cmdln;


function SdcAdmService(top) {
    this.top = top;
    Cmdln.call(this, {
        name: 'sdcadm service',
        desc: 'Operate Triton core services.'
    });
}
util.inherits(SdcAdmService, Cmdln);

SdcAdmService.prototype.init = function init(opts, args, callback) {
    this.sdcadm = this.top.sdcadm;
    this.progress = this.top.progress;
    this.log = this.top.log;

    Cmdln.prototype.init.apply(this, arguments);
};

SdcAdmService.prototype.do_list = require('./do_list');
SdcAdmService.prototype.do_migrate = require('./do_migrate');
SdcAdmService.prototype.do_restore = require('./do_restore');

SdcAdmService.aliases = ['svc'];

module.exports = SdcAdmService;
