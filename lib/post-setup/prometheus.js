/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * The 'sdcadm post-setup prometheus' CLI subcommand.
 */

var errors = require('../errors');
var AddServiceProc = require('../procedures/add-service').AddServiceProcedure;
var runProcs = require('../procedures').runProcs;

function do_prometheus(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        cb(new errors.UsageError('too many args: ' + args));
        return;
    }

    const svcName = 'prometheus';
    const procOpts = {
        svcName: svcName,
        packageName: 'sdc_1024',
        delegatedDataset: true,
        networks: [
            {name: 'admin'},
            // Prometheus needs to be on the external to properly work with
            // CMON's Triton service discovery and CNS -- at least until CNS
            // support split horizon DNS to provide separate records on the
            // admin network.
            //
            // Triton's Prometheus instances will therefore have a NIC on CMON's
            // non-admin network. Currently by default that is the "external"
            // network.
            //
            // A firewall will be setup on prometheus0 so that by default no
            // inbound requests are allowed on that interface.
            {name: 'external', primary: true}
        ],
        firewallEnabled: true
    };

    if (opts.image) {
        procOpts.image = opts.image;
    }

    if (opts.channel) {
        procOpts.channel = opts.channel;
    }

    if (opts.server) {
        procOpts.server = opts.server;
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

do_prometheus.options = [
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
        names: ['server', 's'],
        type: 'string',
        help: 'Either hostname or uuid of the server on which to create' +
            ' the instance. (By default the headnode will be used.)',
        helpArg: 'SERVER'
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
            'updates.joyent.com, "current" for the latest image already ' +
            'in the datacenter (if any), or an image UUID or version.'
    },
    {
        names: ['channel', 'C'],
        type: 'string',
        help: 'The updates.joyent.com channel from which to fetch the ' +
            'image. See `sdcadm channel get` for the default channel.'
    }

];

do_prometheus.help = [
    'Create the "prometheus" service and a first instance.',
    '',
    'Usage:',
    '     {{name}} prometheus',
    '',
    '{{options}}',
    'The "prometheus" service monitors Triton components using the ' +
    'Prometheus time-series database.'
].join('\n');

do_prometheus.logToFile = true;

// --- exports

module.exports = {
    do_prometheus: do_prometheus
};

// vim: set softtabstop=4 shiftwidth=4:
