/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * The 'sdcadm experimental remove-ca' CLI subcommand to remove the Cloud
 * Analytics (CA) service from TritonDC.
 */

var RemoveServicesProcedure = require('../procedures/remove-services')
    .RemoveServicesProcedure;
var runProcs = require('../procedures').runProcs;

function do_remove_ca(subcmd, opts, _args, cb) {
    var self = this;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    var procs = [
        new RemoveServicesProcedure({
            svcNames: ['ca', 'cabase', 'cainstsvc'],
            includeServerNames: opts.servers,
            excludeServerNames: opts.exclude_servers
        })
    ];
    runProcs({
        log: self.log,
        procs: procs,
        sdcadm: self.sdcadm,
        ui: self.ui,
        dryRun: opts.dry_run,
        skipConfirm: opts.yes
    }, function done(err) {
        cb(err);
    });
}

do_remove_ca.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['yes', 'y'],
        type: 'bool',
        help: 'Answer yes to all confirmations.'
    },
    {
        names: ['dry-run', 'n'],
        type: 'bool',
        help: 'Do a dry-run.'
    },
    {
        group: 'Server selection (by default agents on all setup servers ' +
            'are removed)'
    },
    {
        names: ['servers', 's'],
        type: 'arrayOfCommaSepString',
        helpArg: 'NAMES',
        help: 'Comma-separated list of servers (either hostnames or uuids) ' +
            'where agents will be removed.'
    },
    {
        names: ['exclude-servers', 'S'],
        type: 'arrayOfCommaSepString',
        helpArg: 'NAMES',
        help: 'Comma-separated list of servers (either hostnames or uuids) ' +
            'to exclude from the set of servers on which agents will be ' +
            'removed.'
    }
];

do_remove_ca.helpOpts = {
    maxHelpCol: 25
};

do_remove_ca.help = [
    'Remove the Cloud Analytics services from Triton.',
    '',
    'Usage:',
    '     {{name}} remove-ca',
    '',
    '{{options}}',
    'Cloud Analytics (CA) has been deprecated. This command will remove CA',
    'related service agents and VMs.'
].join('\n');

do_remove_ca.logToFile = true;

// --- exports

module.exports = {
    do_remove_ca: do_remove_ca
};
