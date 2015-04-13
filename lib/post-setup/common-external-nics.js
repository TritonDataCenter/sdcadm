/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * 'sdcadm post-setup common-external-nics'
 */

var p = console.log;
var assert = require('assert-plus');



//---- internal support stuff

function CommonExternalNics() {}
CommonExternalNics.prototype.name = 'common-external-nics';
CommonExternalNics.prototype.help = (
    'Add external NICs to the adminui and imgapi zones.\n' +
    '\n' +
    'By default no SDC core zones are given external nics in initial\n' +
    'setup. Typically it is most useful to have those for the adminui\n' +
    'instance (to be able to access the operator portal in your browser)\n' +
    'and for the imgapi instance (to enable it to reach out to \n' +
    'updates.joyent.com and images.joyent.com for images). IMGAPI\n' +
    'instances are always firewalled such that only outbound connections\n' +
    'are allowed.\n'
);
CommonExternalNics.prototype.execute = function (options, cb) {
    assert.object(options.sdcadm, 'options.sdcadm');
    assert.object(options.log, 'options.log');
    assert.func(options.progress, 'options.progress');

    var sdcadm = options.sdcadm;

    sdcadm.setupCommonExternalNics({
        progress: options.progress
    }, cb);
};



//---- CLI

function do_common_external_nics(subcmd, opts, args, cb) {
    var proc = new CommonExternalNics();
    proc.execute({
            sdcadm: this.sdcadm,
            log: this.log.child({postSetup: 'common-external-nics'}, true),
            progress: this.progress
        }, cb);
}

do_common_external_nics.help = (
    CommonExternalNics.prototype.help +
    '\n' +
    'Usage:\n' +
    '     {{name}} common-external-nics\n'
);



//---- exports

module.exports = {
    do_common_external_nics: do_common_external_nics
};
