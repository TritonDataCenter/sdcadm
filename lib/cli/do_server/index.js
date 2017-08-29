/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

/*
 * 'sdcadm headnode ...'
 */

var util = require('util');

var cmdln = require('cmdln');
var Cmdln = cmdln.Cmdln;


function SdcAdmServer(top) {
    this.top = top;
    Cmdln.call(this, {
        name: 'sdcadm headnode',
        desc: 'Operate DC servers.'
    });
}
util.inherits(SdcAdmServer, Cmdln);

SdcAdmServer.prototype.init = function init(opts, args, callback) {
    this.sdcadm = this.top.sdcadm;
    this.progress = this.top.progress;
    this.log = this.top.log;

    Cmdln.prototype.init.apply(this, arguments);
};

SdcAdmServer.prototype.do_list = require('./do_list');
SdcAdmServer.prototype.do_headnode_setup = require('./do_headnode_setup');

// XXX keep this around for now. Eventually will be 'sdcadm service migrate ...'
//SdcAdmServer.prototype.do_takeover = require('./do_takeover');




module.exports = SdcAdmServer;
