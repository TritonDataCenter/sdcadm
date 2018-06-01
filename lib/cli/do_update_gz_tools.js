/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018 Joyent, Inc.
 */
var child_process = require('child_process');
var exec = child_process.exec;
var fs = require('fs');
var net = require('net');
var util = require('util');
var format = util.format;
var path = require('path');

var assert = require('assert-plus');
var ProgressBar = require('progbar').ProgressBar;

var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');
var ur = require('../ur');

function UpdateGzTools(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.cli, 'opts.cli');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.func(opts.progress, 'opts.progress');
    assert.string(opts.uuid, 'opts.uuid');

    this.log = opts.log;
    this.sdcadm = opts.sdcadm;
    this.progress = opts.progress;
    this.uuid = opts.uuid;
    this.cli = opts.cli;
}

UpdateGzTools.prototype.name = 'update-gz-tools';

/*
 * Fetch a given gz-tools tarball image (or if desired, latest), download it,
 * then do the following:
 *
 * - Update SDC zone tools (tools.tar.gz)
 * - Update GZ scripts
 * - Update /usbkey/default
 * - Update cn_tools.tar.gz on all Compute Nodes
 */

UpdateGzTools.prototype.execute = function cExecute(opts, args, callback) {
    assert.object(opts, 'opts');
    assert.object(args, 'args');
    assert.func(callback, 'callback');

    assert.string(opts.image, 'opts.image');
    assert.number(opts.concurrency, 'opts.concurrency');
    assert.optionalBool(opts.justDownload, 'opts.justDownload');
    assert.optionalBool(opts.forceReinstall, 'opts.forceReinstall');
    assert.func(opts.progress, 'opts.progress');

    var self = this;
    var localdir = '/var/tmp';
    var deleteOnFinish = true;
    var filepath;
    var image;
    var sdcZone;
    var progress = opts.progress;
    var timestamp = Math.floor(new Date().getTime() / 1000);
    var tmpToolsDir = format('%s/gz-tools', localdir);
    var justDownload = opts.justDownload;
    var forceReinstall = opts.forceReinstall;
    var localVersion;
    var useFile = false;
    var sdcadm = self.sdcadm;

    function findTarballImageLatest(cb) {
        var filter = {
            name: 'gz-tools'
        };
        sdcadm.updates.listImages(filter, function listCb(err, images) {
            if (err) {
                cb(new errors.SDCClientError(err, 'updates'));
                return;
            }
            if (Array.isArray(images) && !images.length) {
                cb(new errors.UpdateError('no images found'));
                return;
            }
            common.sortArrayOfObjects(images, ['published_at']);
            image = images[images.length - 1];

            cb();
        });
    }

    function findTarballImageByUuid(cb) {
        sdcadm.updates.getImage(opts.image, function (err, foundImage) {
            if (err) {
                cb(new errors.SDCClientError(err, 'updates'));
                return;
            }
            image = foundImage;
            cb();
        });
    }

    function downloadTarballImage(cb) {
        progress('Downloading gz-tools');
        progress(common.indent(util.format('image: %s (%s)',
                        image.uuid, image.version)));
        progress(common.indent(util.format('to: %s', filepath)));

        function onImage(err) {
            if (err) {
                cb(new errors.SDCClientError(err, 'updates'));
                return;
            }
            cb();
        }

        sdcadm.updates.getImageFile(image.uuid, filepath, onImage);
    }

    function validateTarballFiles(cb) {
        progress('Validating gz-tools tarball files');
        vasync.pipeline({ funcs: [
            function checkScriptsDir(_, next) {
                fs.stat(tmpToolsDir + '/scripts', function statCb(er, st) {
                    if (er || !st.isDirectory()) {
                        if (er) {
                            sdcadm.log.error({
                                err: er
                            }, 'Missing gz-tools "scripts" directory');
                        }
                        next(new errors.UpdateError('The provided ' +
                        'file does not include the \'/scripts\' directory'));
                        return;
                    }
                    next();
                });
            },
            function checkToolsTgz(_, next) {
                fs.stat(tmpToolsDir + '/tools.tar.gz', function statCb(er, st) {
                    if (er || !st.isFile()) {
                        if (er) {
                            sdcadm.log.error({
                                err: er
                            }, 'Missing gz-tools file');
                        }

                        next(new errors.UpdateError('The provided ' +
                        'file does not include the \'/tools.tar.gz\' file'));
                        return;
                    }
                    next();
                });
            },
            function checkDefaultDir(_, next) {
                fs.stat(tmpToolsDir + '/default', function statCb(er, st) {
                    if (er || !st.isDirectory()) {
                        if (er) {
                            sdcadm.log.error({
                                err: er
                            }, 'Missing gz-tools "default" directory');
                        }

                        next(new errors.UpdateError('The provided ' +
                        'file does not include the \'/default\' directory'));
                        return;
                    }
                    next();
                });
            },
            function checkCnToolsTgz(_, next) {
                fs.stat(tmpToolsDir + '/cn_tools.tar.gz',
                    function statCb(er, st) {
                    if (er || !st.isFile()) {
                        if (er) {
                            sdcadm.log.error({
                                err: er
                            }, 'Missing gz-tools "cn_tools.tar.gz" file');
                        }

                        next(new errors.UpdateError(
                            'The provided file does not include the ' +
                            '\'/cn_tools.tar.gz\' file'));
                        return;
                    }
                    next();
                });
            }
        ]}, cb);
    }

    function updateSdcFiles(cb) {
        progress('Updating "sdc" zone tools');
        vasync.pipeline({funcs: [
            function removeSymlink(_, next) {
                var argv = ['rm', '-rf', '/opt/smartdc/sdc'];
                common.execFilePlus({argv: argv, log: sdcadm.log}, next);
            },
            function reSymlink(_, next) {
                var argv = [
                    'ln', '-s',
                    '/zones/' + sdcZone.uuid + '/root/opt/smartdc/sdc',
                    '/opt/smartdc/sdc'
                ];
                common.execFilePlus({argv: argv, log: sdcadm.log}, next);
            },
            function decompressTools(_, next) {
                // tools.tar.gz will be located at $tmpToolsDir/tools.tar.gz
                var argv = [
                    '/usr/bin/tar',
                    'xzof',
                    tmpToolsDir + '/tools.tar.gz',
                    '-C', '/opt/smartdc'
                ];
                common.execFilePlus({argv: argv, log: sdcadm.log}, next);
            },
            function cleanupSemverFile(_, next) {
                // Remove semver.js from an old sdc-clients-light version
                var sverFile = '/opt/smartdc/node_modules/sdc-clients/' +
                    'node_modules/semver.js';

                if (!fs.existsSync(sverFile)) {
                    next();
                    return;
                }

                fs.unlink(sverFile, function (err) {
                    if (err) {
                        sdcadm.log.warn(err, 'unlinking %s', sverFile);
                    }
                    next();
                });
            }
        ]}, cb);
    }

    function updateScripts(cb) {
        progress('Updating global zone scripts');
        vasync.pipeline({funcs: [
            function mountUsbKey(_, next) {
                progress('Mounting USB key');
                common.mountUsbKey(sdcadm.log, next);
            },

            function backupScriptsDir(_, next) {
                var argv = [
                    'cp', '-Rp',
                    '/usbkey/scripts',
                    localdir + '/pre-upgrade.scripts.' + timestamp
                ];
                common.execFilePlus({argv: argv, log: sdcadm.log}, next);
            },

            function backupToolsFile(_, next) {
                if (!fs.existsSync('/usbkey/tools.tar.gz')) {
                    next();
                    return;
                }
                var argv = [
                    'cp',
                    '/usbkey/tools.tar.gz',
                    localdir + '/pre-upgrade.tools.' + timestamp + '.tar.gz'
                ];
                common.execFilePlus({argv: argv, log: sdcadm.log}, next);
            },

            // keep a finite number cn_tools backups on the usb key
            function removeOldCNToolsTarballs(_, next) {
                var backupPath = '/usbkey/extra/joysetup/';
                var tarballs = fs.readdirSync(backupPath).filter(
                    function isCNTools(p) {
                        return (p.startsWith('cn_tools.') &&
                                p.endsWith('tar.gz') &&
                                p !== 'cn_tools.tar.gz');
                    });
                tarballs.sort();
                tarballs.reverse();
                var toDelete = tarballs.slice(4);
                if (toDelete.length) {
                    progress('Removing old cn backups: ' + toDelete.join(', '));
                    toDelete.forEach(function rmBall(fname) {
                        fs.unlinkSync(path.join(backupPath, fname));
                    });
                }
                next();
            },

            function backupCNToolsFile(_, next) {
                if (!fs.existsSync('/usbkey/extra/joysetup/cn_tools.tar.gz')) {
                    next();
                    return;
                }
                var cnToolsTimestamp = new Date().toISOString()
                    .split('.')[0].replace(/[:.-]/g, '');
                fs.rename('/usbkey/extra/joysetup/cn_tools.tar.gz',
                      '/usbkey/extra/joysetup/cn_tools.' + cnToolsTimestamp +
                      '.tar.gz', function (err) {
                          if (err) {
                              next(new errors.InternalError(err));
                              return;
                          }
                          next();
                      });
            },

            function removeScriptsDir(_, next) {
                var argv = [
                    'rm', '-rf',
                    '/mnt/usbkey/scripts'
                ];
                common.execFilePlus({argv: argv, log: sdcadm.log}, next);
            },

            function copyScriptsToUSBKey(_, next) {
                var argv = [
                    'cp', '-Rp',
                    tmpToolsDir + '/scripts',
                    '/mnt/usbkey/'
                ];
                common.execFilePlus({argv: argv, log: sdcadm.log}, next);
            },

            function copyToolsToUSBKey(_, next) {
                var argv = [
                    'cp',
                    tmpToolsDir + '/tools.tar.gz',
                    '/mnt/usbkey/tools.tar.gz'
                ];
                common.execFilePlus({argv: argv, log: sdcadm.log}, next);
            },

            function copyCnToolsToUSBKey(_, next) {
                common.copyFile(
                    tmpToolsDir + '/cn_tools.tar.gz',
                    '/usbkey/extra/joysetup/cn_tools.tar.gz',
                    next);
            },

            function copyDefaultDirToUsbKey(_, next) {
                var cmd = ['cp', tmpToolsDir + '/default/*',
                    '/mnt/usbkey/default'];

                exec(cmd.join(' '), function (err, stdout, stderr) {
                    sdcadm.log.trace({cmd: cmd, err: err, stdout: stdout,
                        stderr: stderr}, 'ran cp command');
                    if (err) {
                        next(new errors.InternalError({
                            message: 'error running cp command',
                            cmd: cmd,
                            stdout: stdout,
                            stderr: stderr,
                            cause: err
                        }));
                        return;
                    }
                    next();
                });
            },

            function rsyncScriptsToCache(_, next) {
                var argv = [
                    'rsync', '-avi',
                    '--exclude', 'private',
                    '--exclude', 'os',
                    '/mnt/usbkey/', '/usbkey/'
                ];
                common.execFilePlus({argv: argv, log: sdcadm.log}, next);
            },

            function copyJoysetup(_, next) {
                var argv = [
                    'cp',
                    tmpToolsDir + '/scripts/joysetup.sh',
                    '/usbkey/extra/joysetup/'
                ];
                common.execFilePlus({argv: argv, log: sdcadm.log}, next);
            },

            function copyAgentSetup(_, next) {
                var argv = [
                    'cp',
                    tmpToolsDir + '/scripts/agentsetup.sh',
                    '/usbkey/extra/joysetup/'
                ];
                common.execFilePlus({argv: argv, log: sdcadm.log}, next);
            },


            function unmountUsbKey(_, next) {
                progress('Unmounting USB key');
                common.unmountUsbKey(sdcadm.log, next);
            }
        ]}, cb);
    }

    function cleanup(cb) {
        progress('Cleaning up gz-tools tarball');
        fs.unlink(filepath, function (err) {
            if (err) {
                sdcadm.log.warn(err, 'unlinking %s', filepath);
            }
            cb();
        });
    }

    var context = {
        urconn: null,
        serversToUpdate: null
    };

    vasync.pipeline({arg: context, funcs: [
        function getChannelIfNeeded(_, next) {
            sdcadm.getDefaultChannel(function getChannelCb(err, channel) {
                // Will not fail the whole operation due to channel not found
                if (err) {
                    next();
                    return;
                }
                if (opts.image === 'latest' ||
                        !fs.existsSync(opts.image)) {
                    progress('Using channel %s', channel);
                }
                next();
            });
        },

        function findImage(_, next) {
            if (opts.image === 'latest') {
                findTarballImageLatest(next);
            // Check if the value of the parameter `image` is a file
            } else if (fs.existsSync(opts.image)) {
                filepath = opts.image;
                useFile = true;
                deleteOnFinish = false;
                next();
            } else {
                findTarballImageByUuid(next);
            }
        },

        function checkLocalToolsVersion(_, next) {
            var toolsImg = '/opt/smartdc/etc/gz-tools.image';
            fs.stat(toolsImg, function statCb(err, _stat) {
                if (err) {
                    // Just ignore the previous version if cannot read the file
                    next();
                    return;
                }
                fs.readFile(toolsImg, 'utf8', function readFileCb(er2, data) {
                    if (er2) {
                        next();
                        return;
                    }
                    localVersion = data.trim();
                    progress('UUID of latest installed gz-tools image ' +
                                    'is:\n  %s\n', localVersion);
                    if (!useFile && localVersion === image.uuid &&
                            !forceReinstall) {
                        progress('Image %s is already installed.',
                                localVersion);
                        progress('Please re-run with `--force-reinstall` ' +
                                'if you want to override installed image');
                        callback();
                        return;
                    }
                    next();
                });

            });
        },

        function ensureSdcInstance(_, next) {
            var filters = {
                state: 'active',
                owner_uuid: sdcadm.config.ufds_admin_uuid,
                'tag.smartdc_role': 'sdc'
            };
            sdcadm.vmapi.listVms(filters, function listVmsCb(vmsErr, vms) {
                if (vmsErr) {
                    next(vmsErr);
                    return;
                }
                if (Array.isArray(vms) && !vms.length) {
                    next(new errors.UpdateError('no "sdc" VM ' +
                        'instance found'));
                    return;
                }
                sdcZone = vms[0];
                next();
            });
        },

        function downloadTarball(_, next) {
            if (filepath) {
                progress('Using gz-tools tarball file %s', filepath);
                next();
            } else {
                if (image.name !== 'gz-tools') {
                    next(new errors.UsageError(
                        'name of image by given uuid is not \'gz-tools\''));
                    return;
                }
                filepath = format('%s/gz-tools-%s.tgz', localdir, image.uuid);

                if (fs.existsSync(filepath)) {
                    progress('Using gz-tools tarball file %s ' +
                            'from previous download', filepath);
                    next();
                } else {
                    downloadTarballImage(next);
                }
            }
        },

        function decompressTarball(_, next) {
            if (justDownload) {
                deleteOnFinish = false;
                next();
                return;
            }
            var argv = [
                '/usr/bin/tar',
                'xzvof',
                filepath,
                '-C', localdir
            ];

            progress('Decompressing gz-tools tarball');
            common.execFilePlus({argv: argv, log: sdcadm.log}, next);
        },

        function validateTarballContents(_, next) {
            if (justDownload) {
                next();
                return;
            }
            validateTarballFiles(next);
        },

        function updateFiles(_, next) {
            if (justDownload) {
                next();
                return;
            }
            updateSdcFiles(next);
        },

        function upScripts(_, next) {
            if (justDownload) {
                next();
                return;
            }
            updateScripts(next);
        },

       /*
        * Deploy updated compute node tools throughout the data center,
        * and update boot files on the USB key of machines which have one.
        * Check for Ur availability first, as we cannot proceed without
        * it:
        */
        function urDiscoveryGetReady(ctx, next) {
            if (justDownload) {
                next();
                return;
            }

            sdcadm.getUrConnection(function connectCb(err, urconn) {
                if (err) {
                    sdcadm.log.debug({
                        err: err
                    }, 'ur error');
                    next(new errors.InternalError({
                        cause: err,
                        message: 'ur not available (check RabbitMQ)'
                    }));
                    return;
                }

                sdcadm.log.debug('ur connected');
                ctx.urconn = urconn;
                next();
            });
        },

        function findServersToUpdate(ctx, next) {
            if (justDownload) {
                next();
                return;
            }
            progress('Finding servers to update');
            /*
             * The compute node tools are installed into the ZFS pool, which is
             * created during compute node setup.  As such, this process does
             * not currently apply to compute nodes that have not yet been set
             * up.
             */
            sdcadm.cnapi.listServers({
                setup: true
            }, function (err, servers) {
                if (err) {
                    next(new errors.SDCClientError(err, 'cnapi'));
                    return;
                }

                ctx.serversToUpdate = ctx.serversToUpdate || servers;
                next();
            });
        },

        function urDiscovery(ctx, next) {
            if (justDownload) {
                next();
                return;
            }

            common.urDiscovery({
                sdcadm: sdcadm,
                progress: progress,
                nodes: ctx.serversToUpdate.map(
                    function (s) {
                        return s.uuid;
                    }),
                urconn: ctx.urconn
            }, function urConnCb(err, urAvailServers) {
                if (err) {
                    next(err);
                    return;
                }
                ctx.urServersToUpdate = urAvailServers;
                next();
            });
        },

        function updateCNTools(ctx, next) {
            if (justDownload) {
                next();
                return;
            }

            progress('Starting cn_tools update on %d servers',
                ctx.urServersToUpdate.length);

            assert.ok(net.isIPv4(sdcadm.config.assets_admin_ip),
                'sdcadm.config.assets_admin_ip IPv4');

            var tools_url = format('http://%s/extra/joysetup/cn_tools.tar.gz',
                sdcadm.config.assets_admin_ip);

            var downloadAndExtractCmd = [
                '',
                'TOOLS_URL="' + tools_url + '"',
                'TOOLS_FILE="/tmp/cn_tools.$$.tar.gz"',
                '',
                'if ! /usr/bin/curl -sSf "${TOOLS_URL}" -o ' +
                    '"${TOOLS_FILE}"; then',
                '    /usr/bin/rm -f "${TOOLS_FILE}"',
                '    echo "failed to download tools tarball"',
                '    exit 1',
                'fi',
                '',
                'if ! /usr/bin/mkdir -p /opt/smartdc; then',
                '    echo "failed to create /opt/smartdc"',
                '    exit 1',
                'fi',
                '',
                'if ! /usr/bin/tar xzof "${TOOLS_FILE}" -C /opt/smartdc; then',
                '    /usr/bin/rm -f "${TOOLS_FILE}"',
                '    echo "failed to extract tools tarball"',
                '    exit 2',
                'fi',
                '/usr/bin/rm -f "${TOOLS_FILE}"',
                '',
                'exit 0',
                ''
            ].join('\n');

            var updateUSBKeyCmd = [
                '',
                '',
                'if ! /opt/smartdc/bin/sdc-usbkey update --ignore-missing; ' +
                    'then',
                '   exit $?',
                'fi',
                '',
                'exit 0',
                ''
            ].join('\n');


            vasync.forEachPipeline({
                inputs: [
                    {
                        str: downloadAndExtractCmd,
                        progbarName: 'Update compute node tools',
                        timeout: 10 * 60 * 1000
                    },
                    {
                        str: updateUSBKeyCmd,
                        progbarName: 'Update USB key contents',
                        timeout: 10 * 60 * 1000
                    }
                ],
                func: function runUrQueue(cmd, nextCmd) {
                    assert.object(ctx.urconn, 'ctx.urconn');
                    var queueOpts = {
                        sdcadm: sdcadm,
                        urConnection: ctx.urconn,
                        log: sdcadm.log,
                        progress: progress,
                        command: cmd.str,
                        concurrency: opts.concurrency,
                        timeout: cmd.timeout
                    };

                    var bar;
                    if (process.stderr.isTTY) {
                        bar = new ProgressBar({
                            size: ctx.urServersToUpdate.length,
                            bytes: false,
                            filename: cmd.progbarName
                        });
                        queueOpts.progbar = bar;
                    }
                    sdcadm.log.trace({
                        command: cmd.str,
                        concurrency: opts.concurrency
                    }, 'runUrQueue');

                    var rq = ur.runQueue(queueOpts, function qCb(err, results) {
                        if (err) {
                            nextCmd(new errors.UpdateError(
                                err, 'unexpected runQueue error'));
                            return;
                        }

                        var errs = [];
                        results.forEach(function evalResults(r) {
                            if (r.error || r.result.exit_status !== 0) {
                                errs.push(new errors.UpdateError(format(
                                    '%s failed on server %s (%s): %j',
                                    cmd.progbarName, r.uuid, r.hostname,
                                    r.error || r.result)));
                            }
                        });
                        if (errs.length === 1) {
                            nextCmd(errs[0]);
                        } else if (errs.length > 1) {
                            nextCmd(new errors.MultiError(errs));
                        } else {
                            nextCmd();
                        }
                    });

                    rq.on('success', function onSuccess(server, result) {
                        /*
                         * The "success" event means that the process was
                         * successfully started and ran to completion, but we
                         * still need to check for a non-zero exit status.
                         */
                        if (result.exit_status !== 0) {
                            var errmsg = format(
                                '%s failed on server %s (%s): %j',
                                cmd.progbarName, server.uuid,
                                server.hostname, result);
                            if (cmd.logFile) {
                                errmsg += ' (log file on server: ' +
                                    cmd.logFile + ')';
                            }
                            if (bar) {
                                bar.log(errmsg);
                            } else {
                                console.log(errmsg);
                            }
                        }
                    });

                    rq.start();
                    ctx.urServersToUpdate.forEach(function (us) {
                        rq.add_server(us);
                    });
                    rq.close();
                }
            }, next);
        },

        function (_, next) {
            if (deleteOnFinish) {
                cleanup(next);
            } else {
                next();
            }
        }

    ]}, callback);

};


/*
 * The 'sdcadm experimental update-gz-tools' CLI subcommand.
 */

/**
 * This is the temporary quick replacement for incr-upgrade's
 * "upgrade-tools.sh".
 */

function do_update_gz_tools(subcmd, opts, args, cb) {
    var self = this;
    var progress = self.progress;
    var execStart = Date.now();

    assert.object(opts, 'opts');
    assert.optionalString(opts.channel, 'opts.channel');

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    function finish(err) {
        if (err) {
            return cb(err);
        }
        progress('Updated gz-tools successfully (elapsed %ds).',
            Math.floor((Date.now() - execStart) / 1000));
        return cb();
    }

    if (!opts.latest && !args[0]) {
        finish(new errors.UsageError(
            'must specify installer image UUID or --latest'));
        return;
    }

    vasync.pipeline({funcs: [
        function ensureSdcApp(_, next) {
            self.sdcadm.ensureSdcApp({}, next);
        },
        function updateGzTools(_, next) {
            // Set or override the default channel if anything is given:
            if (opts.channel) {
                self.sdcadm.updates.channel = opts.channel;
            }

            var proc = new UpdateGzTools({
                sdcadm: self.sdcadm,
                log: self.log,
                uuid: self.top.uuid,
                progress: self.progress,
                cli: self
            });

            proc.execute({
                image: opts.latest ? 'latest' : args[0],
                progress: progress,
                justDownload: opts.just_download,
                forceReinstall: opts.force_reinstall,
                concurrency: opts.concurrency
            }, args, next);
        }
    ]}, finish);
}

do_update_gz_tools.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['latest'],
        type: 'bool',
        help: 'Update using the last published gz-tools installer.'
    },
    {
        names: ['force-reinstall'],
        type: 'bool',
        help: 'Force reinstall of the current gz-tools image in use.'
    },
    {
        names: ['just-download'],
        type: 'bool',
        help: 'Download the GZ Tools installer for later usage.'
    },
    {
        names: ['concurrency', 'j'],
        type: 'integer',
        'default': 5,
        help: 'Number of concurrent servers downloading cn_tools file or ' +
            'being updated simultaneously. Default: 5',
        helpArg: 'CONCURRENCY'
    },
    {
        names: ['channel', 'C'],
        type: 'string',
        help: 'Use the given channel to fetch the image, even if it is not ' +
            'the default one.'
    }
];
do_update_gz_tools.help = (
    'Temporary grabbag for updating the SDC global zone tools.\n' +
    'The eventual goal is to integrate all of this into "sdcadm update".\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} update-gz-tools IMAGE-UUID\n' +
    '     {{name}} update-gz-tools PATH-TO-INSTALLER\n' +
    '     {{name}} update-gz-tools --latest\n' +
    '\n' +
    '{{options}}'
);

// --- exports

module.exports = {
    do_update_gz_tools: do_update_gz_tools
};
