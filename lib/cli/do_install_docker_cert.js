/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');
var svcadm = require('../svcadm');

/*
 * The 'sdcadm experimental install-docker-cert' CLI subcommand.
 */

/**
 * Installs a custom TLS certificate for the sdc-docker service. By default
 * sdc-docker uses a self-signed certificate that gets created when the zone
 * is created for the first time. This command allows installing a custom
 * certificate to be used by sdc-docker.
 */

function do_install_docker_cert(subcmd, opts, args, cb) {
    var self = this;
    var dockerVm;

    if (!opts.key) {
        return cb(new errors.UsageError(
            'must specify certificate key path (-k or --key)'));
    }
    if (!opts.cert) {
        return cb(new errors.UsageError(
            'must specify certificate path (-c or --cert)'));
    }

    vasync.pipeline({funcs: [
        function ensureDockerInstance(_, next) {
            var filters = {
                state: 'active',
                owner_uuid: self.sdcadm.config.ufds_admin_uuid,
                'tag.smartdc_role': 'docker'
            };
            self.sdcadm.vmapi.listVms(filters, function (vmsErr, vms) {
                if (vmsErr) {
                    return next(vmsErr);
                }
                if (Array.isArray(vms) && !vms.length) {
                    return next(new errors.UpdateError('no "docker" VM ' +
                        'instance found'));
                }
                dockerVm = vms[0];
                return next();
            });
        },

        function installKey(_, next) {
            self.progress('Installing certificate');
            var argv = [
                'cp',
                opts.key,
                '/zones/' + dockerVm.uuid + '/root/data/tls/key.pem'
            ];

            common.execFilePlus({
                argv: argv,
                log: self.log
            }, function (err, stdout, stderr) {
                self.log.trace({cmd: argv.join(' '), err: err, stdout: stdout,
                    stderr: stderr}, 'ran cp command');
                if (err) {
                    return next(new errors.InternalError({
                        message: 'error installing certificate key',
                        cmd: argv.join(' '),
                        stdout: stdout,
                        stderr: stderr,
                        cause: err
                    }));
                }
                next();
            });
        },

        function installCertificate(_, next) {
            var argv = [
                'cp',
                opts.cert,
                '/zones/' + dockerVm.uuid + '/root/data/tls/cert.pem'
            ];

            common.execFilePlus({
                argv: argv,
                log: self.log
            }, function (err, stdout, stderr) {
                self.log.trace({cmd: argv.join(' '), err: err, stdout: stdout,
                    stderr: stderr}, 'ran cp command');
                if (err) {
                    return next(new errors.InternalError({
                        message: 'error installing certificate',
                        cmd: argv.join(' '),
                        stdout: stdout,
                        stderr: stderr,
                        cause: err
                    }));
                }
                next();
            });
        },

        function restartSdcDockerSvc(_, next) {
            self.progress('Restarting sdc-docker service');

            svcadm.svcadmRestart({
                fmri: 'docker',
                zone: dockerVm.uuid,
                log: self.log
            }, next);
        }
    ]}, cb);
}

do_install_docker_cert.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['cert', 'c'],
        type: 'string',
        help: 'Path to certificate.'
    },
    {
        names: ['key', 'k'],
        type: 'string',
        help: 'Path to private key.'
    }
];
do_install_docker_cert.help = (
    'Installs a custom TLS certificate to be used by sdc-docker.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} install-docker-cert\n' +
    '\n' +
    '{{options}}'
);

// --- exports

module.exports = {
    do_install_docker_cert: do_install_docker_cert
};
