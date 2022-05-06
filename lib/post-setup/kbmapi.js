/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * The 'sdcadm post-setup kbmapi' CLI subcommand.
 */

var errors = require('../errors');
var AddServiceProc = require('../procedures/add-service').AddServiceProcedure;
var runProcs = require('../procedures').runProcs;

function do_kbmapi(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        cb(new errors.UsageError('too many args: ' + args));
        return;
    }



    const svcName = 'kbmapi';
    const procOpts = {
        svcName: svcName,
        packageName: 'sdc_1024',
        delegatedDataset: false,
        networks: [
            {name: 'admin'}
        ],
        firewallEnabled: false
    };
    if (opts.image) {
        procOpts.image = opts.image;
    }

    if (opts.channel) {
        procOpts.channel = opts.channel;
    }

    const proc = new AddServiceProc(procOpts);

    runProcs({
        log: self.log,
        procs: [proc],
        sdcadm: self.sdcadm,
        ui: self.ui,
        dryRun: opts.dry_run,
        skipConfirm: opts.yes
    }, cb);
}

do_kbmapi.options = [
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
        group: 'Image selection (by default latest image on default ' +
            'channel)'
    },
    {
        names: ['image', 'i'],
        type: 'string',
        help: 'Specifies which image to use for the first instance. ' +
            'Use "latest" (the default) for the latest available on ' +
            'updates.tritondatacenter.com, "current" for the latest image ' +
            'already in the datacenter (if any), or an image UUID or version.'
    },
    {
        names: ['channel', 'C'],
        type: 'string',
        help: 'The updates.tritondatacenter.com channel from which to fetch ' +
            'the image. See `sdcadm channel get` for the default channel.'
    }

];

do_kbmapi.help = [
    'Setup the Key Backup and Management API (KBMAPI) service',
    'and create the first instance.',
    '',
    'Usage:',
    '     {{name}} kbmapi',
    '',
    '{{options}}',
    'The "kbmapi" service manages the pivtokens on Triton compute nodes' +
    ' containing encrypted zpools.'
].join('\n');

do_kbmapi.logToFile = true;

// --- exports

module.exports = {
    do_kbmapi: do_kbmapi
};

// vim: set softtabstop=4 shiftwidth=4:
