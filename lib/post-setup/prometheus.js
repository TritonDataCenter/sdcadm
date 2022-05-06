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

var vasync = require('vasync');
var verror = require('verror');

var errors = require('../errors');
var AddServiceProc = require('../procedures/add-service').AddServiceProcedure;
var AddAllowTransferProc =
    require('../procedures/add-allow-transfer').AddAllowTransferProcedure;
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
    const addServiceOpts = {
        svcName: svcName,
        packageName: 'sdc_1024',
        delegatedDataset: true,
        dependencies: ['cmon', 'cns'],
        networks: [
            {name: 'admin'},
            /*
             * Prometheus needs to be on the external to properly work with
             * CMON's Triton service discovery and CNS -- at least until CNS
             * supports split horizon DNS to provide separate records on the
             * admin network.
             *
             * Triton's Prometheus instances will therefore have a NIC on CMON's
             * non-admin network. Currently by default that is the "external"
             * network.
             *
             * A firewall will be setup on prometheus0 so that by default no
             * inbound requests are allowed on that interface.
             */
            {name: 'external', primary: true}
        ],
        firewallEnabled: true
    };

    if (opts.image) {
        addServiceOpts.image = opts.image;
    }

    if (opts.channel) {
        addServiceOpts.channel = opts.channel;
    }

    if (opts.server) {
        addServiceOpts.server = opts.server;
    }

    /*
     * We set 'volatile' to true here because we're also (possibly) creating the
     * Prometheus service and instance in the same runProcs sequence, and thus
     * must defer lookup of the service and instance to the execute() phase.
     */
    const addAllowTransferOpts = {
        svcName: svcName,
        nicTag: 'admin',
        volatile: true
    };

    const addServiceProc = new AddServiceProc(addServiceOpts);
    const addAllowTransferProc = new AddAllowTransferProc(addAllowTransferOpts);

    vasync.pipeline({
        arg: {},
        funcs: [
            function checkCnsEnabled(_, next) {
                self.sdcadm.ufds.getUserEx({
                    searchType: 'uuid',
                    value: self.sdcadm.config.ufds_admin_uuid
                }, function gotUfds(err, user) {
                    var ufdsErr = null;
                    if (err) {
                        ufdsErr = err;
                    } else if (user.triton_cns_enabled !== 'true') {
                        ufdsErr = new verror.VError('The prometheus service ' +
                            'requires the admin user to have ' +
                            '\'triton_cns_enabled\' set to \'true\'');
                    }
                    /*
                     * We have to report any UFDS request error from the block
                     * of code above, as well as any error encountered when
                     * attempting to close the UFDS connection. Thus, we use
                     * verror.errorFromList to return a MultiError object, one
                     * error, or no errors as appropriate. Eurgh!
                     */
                    self.sdcadm.ufds.close(function closedUfds(closeErr) {
                        var errs = [ufdsErr, closeErr];
                        errs = errs.filter(function checkErrDefined(e) {
                            return e !== null && e !== undefined;
                        });
                        next(verror.errorFromList(errs));
                    });
                });
            },
            function addPrometheus(_, next) {
                runProcs({
                    log: self.log,
                    procs: [addServiceProc, addAllowTransferProc],
                    sdcadm: self.sdcadm,
                    ui: self.ui,
                    dryRun: opts.dry_run,
                    skipConfirm: opts.yes
                }, next);
            }
        ]
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
            'updates.tritondatacenter.com, "current" for the latest image ' +
            'already  in the datacenter (if any), or an image UUID or version.'
    },
    {
        names: ['channel', 'C'],
        type: 'string',
        help: 'The updates.tritondatacenter.com channel from which to fetch ' +
            'the image. See `sdcadm channel get` for the default channel.'
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
