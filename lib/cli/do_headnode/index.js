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


function SdcAdmHeadnode(top) {
    this.top = top;
    Cmdln.call(this, {
        name: 'sdcadm headnode',
        desc: [
            'Operate headnode servers.',
            '',
            'See "sdcadm post-setup headnode" for setting up headnodes.'
        ].join('\n')
    });
}
util.inherits(SdcAdmHeadnode, Cmdln);

SdcAdmHeadnode.prototype.init = function init(opts, args, callback) {
    this.sdcadm = this.top.sdcadm;
    this.progress = this.top.progress;
    this.log = this.top.log;

    Cmdln.prototype.init.apply(this, arguments);
};

SdcAdmHeadnode.prototype.do_list = require('./do_list');
SdcAdmHeadnode.prototype.do_takeover = require('./do_takeover');


module.exports = SdcAdmHeadnode;
