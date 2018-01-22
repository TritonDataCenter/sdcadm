/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018 Joyent, Inc.
 */

var util = require('util');
var format = util.format;

var common = require('../common');
var errors = require('../errors');
var steps = require('../steps');

function do_fix_core_vm_resolvers(subcmd, opts, args, cb) {
    var self = this;
    var progress = self.progress;
    var log = self.log;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        cb(new errors.UsageError('too many args: ' + args));
        return;
    }

    steps.checkCoreVmInstancesResolvers({
        sdcadm: self.sdcadm,
        progress: progress,
        log: log,
        adminOnly: opts.admin_only
    }, function (err, resolvers) {
        if (err) {
            cb(err);
            return;
        }

        Object.keys(resolvers).forEach(function (r) {
            progress(
                format('VM %s resolvers need to be updated\n', r) +
                common.indent(format('from [%s] to [%s]',
                    resolvers[r].current.join(', '),
                    resolvers[r].expected.join(', '))));
        });

        if (opts.dry_run) {
            cb();
            return;
        }

        steps.updateCoreVmsResolvers({
            sdcadm: self.sdcadm,
            progress: progress,
            log: log,
            fixableResolvers: resolvers
        }, function (updateError) {
            cb(updateError);
        });
    });
}


do_fix_core_vm_resolvers.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['dry-run', 'n'],
        type: 'bool',
        help: 'Go through the motions without actually updating.'
    },
    {
        names: ['admin-only', 'o'],
        type: 'bool',
        help: 'Only update resolvers for VMs with a NIC on the admin network.'
    }
];
do_fix_core_vm_resolvers.help = (
    'Temporary grabbag for fixing resolvers for core resources VMs.\n' +
    'This will be integrated into "sdcadm post-setup ha-binder".\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} core-vm-resolvers\n' +
    '\n' +
    '{{options}}'
);

// --- exports

module.exports = {
    do_fix_core_vm_resolvers: do_fix_core_vm_resolvers
};

// vim: set softtabstop=4 shiftwidth=4:
