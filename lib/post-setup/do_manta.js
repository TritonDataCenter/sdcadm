/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * The 'sdcadm post-setup manta' CLI subcommand.
 *
 * This is used to bootstrap a Manta (mantav1 or mantav2) installation by
 * creating the "manta" service on the "sdc" SAPI application.
 *
 * Note: eventually this will also be the command to convert from a mantav1
 * deployment zone to a mantav2 deployment zone -- beginning the migration
 * of an existing mantav1 to mantav2.
 */

const assert = require('assert-plus');
const vasync = require('vasync');
const VError = require('verror');

const common = require('../common');
const errors = require('../errors');
const manta = require('../manta');
const runProcs = require('../procedures').runProcs;

const AddServiceProcedure = require('../procedures/add-service')
    .AddServiceProcedure;
const EnsureMantaDeploymentGzLinksProcedure =
    require('../procedures/ensure-manta-deployment-gz-links')
    .EnsureMantaDeploymentGzLinksProcedure;
const EnsureNicOnInstancesProcedure =
    require('../procedures/ensure-nic-on-instances')
    .EnsureNicOnInstancesProcedure;
const SetMantav2MigrationMetadataProcedure =
    require('../procedures/set-mantav2-migration-metadata')
    .SetMantav2MigrationMetadataProcedure;


// ---- internal support functions

function getAddServiceOpts(cliOpts, wantMantav2) {
    assert.object(cliOpts, 'cliOpts');
    assert.bool(wantMantav2, 'wantMantav2');

    const addServiceOpts = {
        svcName: 'manta',
        packageName: 'sdc_1024',
        // The manta0 zone instance must be on the headnode. We could look that
        // up (`sdc-cnapi /servers?headnode=true | json -H 0.uuid`) or rely on
        // the `AddServiceProcedure` behaviour of defaulting to the current
        // server. We do the latter (sdcadm is run on the headnode).
        //    server: ...,
        networks: [
            {name: 'admin'},
            {name: 'external', primary: true}
        ],
        firewallEnabled: true
    };

    if (wantMantav2) {
        addServiceOpts.imgNames = manta.MANTAV2_IMG_NAMES;
    } else {
        addServiceOpts.imgNames = manta.MANTAV1_IMG_NAMES;
    }

    if (cliOpts.image) {
        addServiceOpts.image = cliOpts.image;
    }

    if (cliOpts.channel) {
        addServiceOpts.channel = cliOpts.channel;
    }

    return addServiceOpts;
}

function ensureMantaDeploymentSvcAndInst(cli, opts, wantMantav2, cb) {
    assert.object(cli, 'cli');
    assert.object(opts, 'opts');
    assert.bool(wantMantav2, 'wantMantav2');
    assert.func(cb, 'cb');

    const addServiceOpts = getAddServiceOpts(opts, wantMantav2);

    if (wantMantav2) {
        cli.ui.info([
            /* eslint-disable max-len */
            'This will setup for a new Manta v2 deployment.',
            '',
            'This creates a zone on the headnode which provides the tooling for',
            'deploying and maintaining a Manta installation. After this step is',
            'complete, follow the Manta Operator Guide to deploy Manta:',
            '    https://github.com/joyent/manta/blob/master/docs/operator-guide/deployment.md#deploying-manta'
            /* eslint-enable */
        ].join('\n'));
    } else {
        cli.ui.info([
            /* eslint-disable max-len */
            'This will setup for a new Manta v1 deployment.',
            '',
            'Note that mantav1 is no longer the latest version of Manta.',
            'See the following for information on mantav1 vs mantav2:',
            '    https://github.com/joyent/manta/blob/master/docs/mantav2.md',
            '',
            'This creates a zone on the headnode which provides the tooling for',
            'deploying and maintaining a Manta installation. After this step is',
            'complete, follow the Manta Operator Guide to deploy Manta:',
            '    https://github.com/joyent/manta/blob/mantav1/docs/operator-guide.md'
            /* eslint-enable */
        ].join('\n'));
    }

    runProcs({
        log: cli.log,
        procs: [
            new AddServiceProcedure(addServiceOpts),
            new EnsureMantaDeploymentGzLinksProcedure(),
            new EnsureNicOnInstancesProcedure({
                svcNames: ['manta'],
                nicTag: 'external',
                primary: true,
                hardFail: true,
                volatile: true
            })
        ],
        sdcadm: cli.sdcadm,
        ui: cli.ui,
        dryRun: opts.dry_run,
        skipConfirm: opts.yes
    }, cb);
}

function startMantav2Migration(cli, opts, cb) {
    assert.object(cli, 'cli');
    assert.object(opts, 'opts');
    assert.func(cb, 'cb');

    var ui = cli.ui;
    const addServiceOpts = getAddServiceOpts(opts, true);

    vasync.pipeline({funcs: [
        function confirmWantMigration(_, next) {
            // Do a hard confirmation here about mantav2 migration. The usual
            // `-y` option will *not* skip this confirmation.
            //
            // For dev/debugging-only one can set the
            // `YES_I_WANT_TO_MIGRATE_TO_MANTAV2=1` environment variable to skip
            // this confirmation.
            //
            // XXX Change this to require typing in 'mantav2' to pass
            // confirmation.

            var skipMigrationConfirm = Boolean(
                process.env.YES_I_WANT_TO_MIGRATE_TO_MANTAV2);

            /* eslint-disable max-len */
            ui.info('* * *');
            ui.info('This will begin the process of migrating your current Manta from');
            ui.info('mantav1 to mantav2.');
            ui.info('');
            ui.info('WARNING: This migration is *not reversible*. While mantav2 offers new');
            ui.info('features (such as the Buckets API), it is a *backwards incompatible*');
            ui.info('major version that *removes* a number of features, such as Manta');
            ui.info('jobs, snaplinks, and MPU. Read the following for more details:');
            ui.info('    https://github.com/joyent/manta/blob/master/docs/mantav2.md');
            ui.info('* * *');
            /* eslint-enable */

            if (skipMigrationConfirm) {
                next();
                return;
            }
            var msg = 'Would you like to migrate to mantav2? [y/N] ';
            common.promptYesNo({msg: msg, default: 'n'}, function (answer) {
                if (answer !== 'y') {
                    ui.info('Aborting.');
                    next(true);
                    return;
                }

                ui.info('');
                next();
            });
        },

        function doIt(_, next) {
            runProcs({
                log: cli.log,
                procs: [
                    new SetMantav2MigrationMetadataProcedure(),
                    new AddServiceProcedure(addServiceOpts),
                    new EnsureMantaDeploymentGzLinksProcedure(),
                    new EnsureNicOnInstancesProcedure({
                        svcNames: ['manta'],
                        nicTag: 'external',
                        primary: true,
                        hardFail: true,
                        volatile: true
                    })
                ],
                sdcadm: cli.sdcadm,
                ui: ui,
                dryRun: opts.dry_run,
                skipConfirm: opts.yes
            }, next);
        }
    ]}, function finished(err) {
        if (err === true) { // Early pipeline-abort signal.
            err = null;
        }
        cb(err);
    });
}


// ---- the cli subcommand

function do_manta(subcmd, opts, args, cb) {
    const self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        cb(new errors.UsageError('too many args: ' + args));
        return;
    }

    let wantMantav2 = true;
    if (opts.mantav1 && opts.mantav2) {
        cb(new errors.UsageError('cannot use both --mantav1 and --mantav2'));
        return;
    } else if (opts.mantav1) {
        wantMantav2 = false;
    }

    // Ensure the current "mantav" (manta major version), if any, matches the
    // manta version of the deployment image we are being asked to setup.
    manta.getMantav(self.sdcadm, function (err, mantav) {
        self.log.debug({mantav: mantav, err: err}, 'getMantav');
        if (err) {
            cb(err);
            return;
        } else if (mantav === 2 && !wantMantav2) {
            cb(new VError('there is currently a mantav2 SAPI application, ' +
                'cannot downgrade to mantav1'));
        } else if (mantav === 1 && wantMantav2) {
            startMantav2Migration(self, opts, cb);
        } else {
            ensureMantaDeploymentSvcAndInst(self, opts, wantMantav2, cb);
        }
    });
}

do_manta.options = [
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
        group: 'Manta version selection (by default mantav2)'
    },
    {
        names: ['mantav1'],
        type: 'bool',
        help: 'If given, the Manta deployment zone will setup for a ' +
            '*mantav1* deployment. Specifically this means using "mantav1-*" ' +
            'images. See ' +
            '<https://github.com/joyent/manta/blob/master/docs/mantav2.md> ' +
            'for information on mantav1 vs mantav2.'
    },
    {
        names: ['mantav2'],
        type: 'bool',
        help: 'If given or if no "--mantavN" option is given, the Manta ' +
            'deployment zone will setup for a *mantav2* deployment. ' +
            'Specifically this means using "mantav2-*" images. See ' +
            '<https://github.com/joyent/manta/blob/master/docs/mantav2.md> ' +
            'for information on mantav1 vs mantav2.'
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

do_manta.help = [
    /* eslint-disable max-len */
    'Create the "manta" deployment zone to begin a Manta installation',
    '',
    'Usage:',
    '     {{name}} manta',
    '',
    '{{options}}',
    'This command handles the first step in deploying Manta: creating the manta',
    'deployment zone.',
    '    https://joyent.github.io/manta/#deploying-manta',
    '',
    'By default this will setup for a *mantav2* deployment. Use the "--mantav1"',
    'option to setup for a mantav1 deployment. See the following for details on',
    'mantav1 vs mantav2:',
    '   https://github.com/joyent/manta/blob/master/docs/mantav2.md',
    '',
    'Note: Eventually this command will support the first step in converting',
    'a mantav1 deployment to a mantav2 deployment. However this is not yet',
    'supported.'
    /* eslint-enable */
].join('\n');

do_manta.helpOpts = {
    maxHelpCol: 19
};

do_manta.logToFile = true;

// --- exports

module.exports = do_manta;
