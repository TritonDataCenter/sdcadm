/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * 'sdcadm post-setup common-external-nics'
 */

var errors = require('../errors');
var EnsureNicProc = require('../procedures/ensure-nic-on-instances')
    .EnsureNicOnInstancesProcedure;
var runProcs = require('../procedures').runProcs;

function do_common_external_nics(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        cb(new errors.UsageError('too many args: ' + args));
        return;
    }

    const ensureNicProc = new EnsureNicProc({
        svcNames: ['imgapi', 'adminui'],
        nicTag: 'external',
        primary: true,
        hardFail: true,
        volatile: false
    });

    runProcs({
        log: self.log,
        procs: [ensureNicProc],
        sdcadm: self.sdcadm,
        ui: self.ui,
        /*
         * Before the introduction of the procedure framework, `post-setup
         * common-external-nics` did not prompt the user for confirmation.
         * Scripts that run `post-setup common-external-nics` rely on this
         * behavior, so we hard-code 'skipConfirm' to 'true' to simulate it.
         *
         * This may change in the future -- a longer-term solution is to add
         * a -y/--yes flag to `post-setup common-external-nics` that skips
         * confirmation, and then update all of the scripts that run this
         * procedure to use the new flag.
         */
        skipConfirm: true
    }, cb);
}

do_common_external_nics.help = (
    'Add external NICs to the adminui and imgapi zones.\n' +
    '\n' +
    'By default no SDC core zones are given external nics in initial\n' +
    'setup. Typically it is most useful to have those for the adminui\n' +
    'instance (to be able to access the operator portal in your browser)\n' +
    'and for the imgapi instance (to enable it to reach out to \n' +
    'updates.joyent.com and images.joyent.com for images). IMGAPI\n' +
    'instances are always firewalled such that only outbound connections\n' +
    'are allowed.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} common-external-nics\n'
);

do_common_external_nics.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];

do_common_external_nics.logToFile = true;

// --- exports

module.exports = {
    do_common_external_nics: do_common_external_nics
};
