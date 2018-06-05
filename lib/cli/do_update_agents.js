/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * The 'sdcadm experimental update-agents' CLI subcommand.
 */

var fs = require('fs');
var path = require('path');
var util = require('util');
var format = util.format;

var assert = require('assert-plus');
var crypto = require('crypto');
var vasync = require('vasync');
var mkdirp = require('mkdirp');
var uuid = require('node-uuid');
var ProgressBar = require('progbar').ProgressBar;
var VError = require('verror');

var common = require('../common');
var errors = require('../errors');
var steps = require('../steps');
var svcadm = require('../svcadm');
var ur = require('../ur');

/*
 * Fetch a given agent installer image (or if desired, latest), download it,
 * then deploy it on the selected servers.
 *
 * @param options.agentsshar {String} A string indicating the agentsshar to
 *      which to update. This is the string 'latest', an updates server UUID, or
 *      a path to a locally downloaded agentsshar.
 * @param options.all {Boolean} Update on all setup servers.
 *      One of `options.all` or `options.servers` must be specified.
 * @param options.servers {Array} Array of server hostnames or UUIDs on which
 *      to update. One of `options.all` or `options.servers` must be specified.
 * ...
 *
 * TODO: finish documenting
 */
function updateAgents(options, callback) {
    assert.object(options, 'options');
    assert.object(options.sdcadm, 'options.sdcadm');
    assert.string(options.agentsshar, 'options.agentsshar');
    assert.optionalBool(options.justDownload, 'options.justDownload');
    assert.optionalBool(options.skipLatestSymlink,
        'options.skipLatestSymlink');
    assert.optionalBool(options.justUpdateSymlink,
        'options.justUpdateSymlink');
    assert.optionalBool(options.yes, 'options.yes');
    assert.optionalBool(options.all, 'options.all');
    assert.optionalArrayOfString(options.servers, 'options.servers');
    assert.func(options.progress, 'options.progress');
    assert.func(callback, 'callback');

    if ((options.all && options.servers) ||
        (!options.all && !options.servers &&
         !options.justDownload && !options.justUpdateSymlink)) {
        callback(new errors.UsageError(
            'must specify exactly one of "options.all" or "options.servers"'));
        return;
    }

    var sdcadm = options.sdcadm;
    var log = sdcadm.log;

    var startTime = Date.now();
    var downloadDir = '/var/tmp';
    var filepath;
    var channel;
    var image;
    var progress = options.progress;
    var justDownload = options.justDownload;
    var skipLatestSymlink = options.skipLatestSymlink;
    var justUpdateSymlink = options.justUpdateSymlink;

    function setImageToLatest(cb) {
        var filter = {
            name: 'agentsshar'
        };
        progress('Finding latest "agentsshar" on updates server (channel "%s")',
            channel);
        sdcadm.updates.listImages(filter, function (err, images) {
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
            progress('Latest is agentsshar %s (%s)', image.uuid, image.version);
            cb();
        });
    }

    function setImageFromUuid(imageUuid, cb) {
        sdcadm.updates.getImage(imageUuid, function (err, foundImage) {
            if (err) {
                cb(new errors.SDCClientError(err, 'updates'));
                return;
            }
            image = foundImage;
            progress('Found agentsshar %s (%s)', image.uuid, image.version);
            cb();
        });
    }

    function sha1Path(filePath, cb) {
        var hash = crypto.createHash('sha1');
        var s = fs.createReadStream(filePath);
        s.on('data', function (d) {
            hash.update(d);
        });
        s.on('end', function () {
            cb(null, hash.digest('hex'));
        });
    }

    var context = {
        progress: progress,
        log: sdcadm.log,
        sdcadm: sdcadm,
        urconn: null
    };

    vasync.pipeline({arg: context, funcs: [
        /*
         * Check for Ur availability first, as we cannot proceed without
         * it:
         */
        function urDiscoveryGetReady(ctx, next) {
            if (justDownload || justUpdateSymlink) {
                next();
                return;
            }

            sdcadm.getUrConnection(function (err, urconn) {
                if (err) {
                    log.debug({
                        err: err
                    }, 'ur error');
                    next(new errors.InternalError({
                        cause: err,
                        message: 'ur not available (check RabbitMQ)'
                    }));
                    return;
                }

                log.debug('ur connected');
                ctx.urconn = urconn;
                next();
            });
        },

        function getChannelIfNeeded(_, next) {
            if (options.agentsshar === 'latest' ||
                common.UUID_RE.test(options.agentsshar)) {
                sdcadm.getDefaultChannel(function (err, ch) {
                    channel = ch;
                    next(err);
                });
            } else {
                next();
            }
        },

        function setImageOrFilepath(_, next) {
            if (options.agentsshar === 'latest') {
                setImageToLatest(next);
            } else if (common.UUID_RE.test(options.agentsshar)) {
                setImageFromUuid(options.agentsshar, next);
            } else if (fs.existsSync(options.agentsshar)) {
                filepath = options.agentsshar;
                next();
            } else {
                next(new Error(format('could not find agentsshar: "%s" is ' +
                    'not a UUID or an existing file', options.agentsshar)));
            }
        },

        function verifyFilepath(_, next) {
            if (!justUpdateSymlink) {
                next();
                return;
            }
            if (!filepath) {
                next(new Error('existing file must be specified when using ' +
                    '"--just-update-symlink" option'));
                return;
            }
            next();
        },

        /*
         * If we are about to download an image, first check to see if that
         * image is already available locally (verifying via checksum).
         * If so, then switch to using that file.
         */
        function haveSharAlready_candidate1(_, next) {
            if (filepath) {
                next();
                return;
            }

            // lla == "Latest Local Agentsshar"
            var llaLink = '/usbkey/extra/agents/latest';
            fs.exists(llaLink, function (exists) {
                if (!exists) {
                    log.debug({llaLink: llaLink}, 'symlink to latest ' +
                        'agentsshar is missing, skipping shortcut');
                    next();
                    return;
                }
                fs.readlink(llaLink, function (err, linkTarget) {
                    if (err) {
                        log.error({err: err, llaLink: llaLink},
                            'could not read agents "latest" symlink');
                        next(new errors.UpdateError(err,
                            'could not read agents "latest" symlink, ' +
                            llaLink));
                        return;
                    }

                    var llaPath = path.resolve(
                        path.dirname(llaLink), linkTarget);
                    log.debug({llaPath: llaPath}, 'latest local agentsshar');
                    sha1Path(llaPath, function (checksumErr, checksum) {
                        if (checksumErr) {
                            next(checksumErr);
                            return;
                        }
                        if (checksum === image.files[0].sha1) {
                            progress('The %s agentsshar already exists ' +
                                'at %s, using it', options.agentsshar,
                                llaPath);
                            filepath = llaPath;
                        }
                        next();
                    });
                });
            });
        },
        function haveSharAlready_candidate2(_, next) {
            if (filepath) {
                next();
                return;
            }

            var predownloadedPath = path.resolve(downloadDir,
                'agent-' + image.uuid + '.sh');
            fs.exists(predownloadedPath, function (exists) {
                if (!exists) {
                    next();
                    return;
                }
                sha1Path(predownloadedPath, function (checksumErr, checksum) {
                    if (checksumErr) {
                        next(checksumErr);
                        return;
                    }
                    if (checksum === image.files[0].sha1) {
                        progress('The %s agentsshar already exists ' +
                            'at %s, using it', options.agentsshar,
                            predownloadedPath);
                        filepath = predownloadedPath;
                    }
                    next();
                });
            });
        },

        function listServers(ctx, next) {
            if (justDownload || justUpdateSymlink) {
                next();
                return;
            }
            progress('Finding servers to update');
            // Get all servers to validate if unsetup servers are selected.
            sdcadm.cnapi.listServers({}, function (err, servers) {
                if (err) {
                    next(err);
                    return;
                }
                ctx.allServers = servers;
                next();
            });
        },

        function findServersToUpdate(ctx, next) {
            if (justDownload || justUpdateSymlink) {
                next();
                return;
            }

            if (options.all) {
                ctx.serversToUpdate = ctx.allServers.filter(function (svr) {
                    return svr.setup;
                });
                next();
            } else {
                var i, s;
                var serverFromUuid = {};
                var serverFromHostname = {};
                for (i = 0; i < ctx.allServers.length; i++) {
                    s = ctx.allServers[i];
                    serverFromUuid[s.uuid] = s;
                    serverFromHostname[s.hostname] = s;
                }

                ctx.serversToUpdate = [];
                var serverToUpdateFromUuid = {};
                var unsetupServerIds = [];
                var notFoundServerIds = [];
                for (i = 0; i < options.servers.length; i++) {
                    var id = options.servers[i];
                    s = serverFromUuid[id] || serverFromHostname[id];
                    if (s) {
                        // Avoid drop dupes in `opts.servers`.
                        if (!serverToUpdateFromUuid[s.uuid]) {
                            ctx.serversToUpdate.push(s);
                            serverToUpdateFromUuid[s.uuid] = true;
                        }
                        if (!s.setup) {
                            unsetupServerIds.push(id);
                        }
                    } else {
                        notFoundServerIds.push(id);
                    }
                }
                if (notFoundServerIds.length) {
                    next(new Error(format(
                        '%d of %d selected servers were not found in CNAPI: %s',
                        notFoundServerIds.length, options.servers.length,
                        notFoundServerIds.join(', '))));
                } else if (unsetupServerIds.length) {
                    next(new Error(format(
                        '%d of %d selected servers are not setup: %s',
                        unsetupServerIds.length, options.servers.length,
                        unsetupServerIds.join(', '))));
                } else {
                    next();
                }
            }
        },

        function urDiscovery(ctx, next) {
            if (justDownload || justUpdateSymlink) {
                next();
                return;
            }

            common.urDiscovery({
                sdcadm: sdcadm,
                progress: progress,
                nodes: ctx.serversToUpdate.map(
                    function (s) { return s.uuid; }),
                urconn: ctx.urconn
            }, function (err, urAvailServers) {
                if (err) {
                    next(err);
                    return;
                }
                ctx.urServersToUpdate = urAvailServers;
                next();
            });
        },

        function earlyAbortForJustDownload(_, next) {
            if (justDownload && filepath) {
                progress('Agentsshar is already downloaded to %s', filepath);
                next(true); // early abort signal
            } else {
                next();
            }
        },

        function confirm(ctx, next) {
            progress('\nThis update will make the following changes:');
            progress(common.indent('Ensure core agent SAPI services exist'));
            if (!filepath) {
                assert.object(image, 'image');
                progress(common.indent(format(
                    'Download agentsshar %s\n    (%s)',
                    image.uuid, image.version)));
            }
            if (!justDownload && !justUpdateSymlink) {
                progress(common.indent(format(
                    'Update GZ agents on %d (of %d) servers using\n' +
                    '    agentsshar %s', ctx.serversToUpdate.length,
                    ctx.allServers.length,
                    (filepath ? filepath : image.version))));
            }
            if (justUpdateSymlink && filepath) {
                progress(common.indent(format('Update ' +
                    '\'/usbkey/extra/agents/latest\' symkink to %s',
                    filepath)));
            }
            progress('');
            if (options.yes) {
                next();
                return;
            }
            var msg = 'Would you like to continue? [y/N] ';
            common.promptYesNo({msg: msg, default: 'n'}, function (answer) {
                if (answer !== 'y') {
                    progress('Aborting agents update');
                    callback();
                    return;
                }
                progress('');
                startTime = Date.now(); // Reset to not count confirm time.
                next();
            });
        },

        steps.sapiEnsureAgentServices,

        function downloadAgentsshar(ctx, next) {
            if (filepath) {
                next();
                return;
            }
            filepath = path.resolve(downloadDir,
                'agent-' + image.uuid + '.sh');
            ctx.deleteAgentssharOnFinish = true;
            progress('Downloading agentsshar from updates server ' +
                '(channel "%s")\n    to %s', channel, filepath);
            sdcadm.updates.getImageFile(image.uuid, filepath, function (err) {
                if (err) {
                    next(new errors.SDCClientError(err, 'updates'));
                } else {
                    next();
                }
            });
        },

        function copyFileToAssetsDir(_, next) {
            if (justDownload) {
                next();
                return;
            }
            var assetsdir = '/usbkey/extra/agents';
            if (path.dirname(filepath) === assetsdir) {
                next();
                return;
            }
            progress('Copy agentsshar to assets dir: %s', assetsdir);
            var argv = ['cp', filepath, assetsdir];
            mkdirp.sync(assetsdir);
            common.execFilePlus({
                argv: argv,
                log: sdcadm.log
            }, function (err, stderr, stdout) {
                sdcadm.log.trace({
                    cmd: argv.join(' '),
                    err: err,
                    stdout: stdout,
                    stderr: stderr
                }, 'ran cp command');
                if (err) {
                    next(new errors.InternalError({
                        message: format('error copying shar file to %s',
                                         assetsdir),
                        cmd: argv.join(' '),
                        stdout: stdout,
                        stderr: stderr,
                        cause: err
                    }));
                    return;
                }
                next();
            });
        },

        function setFileName(ctx, next) {
            ctx.fname = path.basename(filepath);
            next();
        },

        function createLatestSymlink(ctx, next) {
            if (justDownload || skipLatestSymlink) {
                next();
                return;
            }
            var symlink = '/usbkey/extra/agents/latest';
            progress('Create %s symlink', symlink);
            fs.unlink(symlink, function (unlinkErr) {
                if (unlinkErr && unlinkErr.code !== 'ENOENT') {
                    next(new VError(unlinkErr,
                        'Unable to remove % symlink', symlink));
                    return;
                }

                fs.symlink(ctx.fname, symlink, function (symlinkErr) {
                    if (symlinkErr) {
                        next(new VError(symlinkErr,
                            'Unable to create "latest" symlink to "%s"',
                            ctx.fname));
                        return;
                    }
                    next();
                });
            });
        },

        function updateCNAgents(ctx, next) {
            if (justDownload || justUpdateSymlink) {
                next();
                return;
            }

            progress('Starting agentsshar update on %d servers',
                ctx.urServersToUpdate.length);

            var ip = sdcadm.config.assets_admin_ip;
            var f = ctx.fname;
            var ff = '/var/tmp/' + f;
            // Do not override log file if we run installer more than once for
            // the same version.
            // TODO(trent): Won't these build up? Should clean these out.
            var lf = '/var/tmp/' + f + '_' + uuid() + '_install.log';
            var nodeConfigCmd = [
                'cd /var/tmp;',
                '',
                /*
                 * Rename previous node.config file, if exists
                 */
                'if [[ -f /var/tmp/node.config/node.config ]]; then',
                '   mv /var/tmp/node.config/node.config ' +
                /* eslint-disable */
                    '/var/tmp/node.config/node.\$\$.config',
                /* eslint-enable */
                'fi',
                '',
                /*
                 * Update node.config first, just in case
                 *
                 * Exit 33 if cannot download the node.config file
                 */
                'if [[ -z "$(bootparams | grep \'^headnode=true\')" ]]; then',
                '   if [[ ! -d  /var/tmp/node.config ]]; then',
                '       rm /var/tmp/node.config',
                '       mkdir -p /var/tmp/node.config',
                '   fi',
                '',
                '   /usr/bin/curl -ksf http://' + ip +
                        '/extra/joysetup/node.config' +
                        ' -o /var/tmp/node.config/node.config',
                '   if [[ "$?" -ne "0" ]]; then',
                '       exit 33',
                '   fi',
                '',
                /*
                 * Exit non zero if config dir does not exist
                 */
                '   if [[ ! -d  /opt/smartdc/config && -z "$IS_CN" ]]; then',
                '       exit 44',
                '   fi',
                '',
                '   /usr/bin/cp /var/tmp/node.config/node.config ' +
                '/opt/smartdc/config/',
                'fi',
                ''
            ].join('\n');

            var downloadCmd = [
                'cd /var/tmp;',
                /*
                 * Exit non zero if agents dir does not exist
                 */
                'if [[ ! -d  /opt/smartdc/agents/lib ]]; then',
                '   exit 50',
                'fi',
                '',
                /*
                 * Exit 22 if cannot download the installer file (curl code)
                 */
                '/usr/bin/curl -kOsf http://' + ip + '/extra/agents/' + f,
                'if [[ "$?" -ne "0" ]]; then',
                '   exit $?',
                'fi',
                ''
            ].join('\n');

            var installCmd = [
                'cd /var/tmp;',
                '',
                /*
                 * Exit 60 if installer fails
                 */
                '/usr/bin/bash ' + ff + ' </dev/null >' + lf + ' 2>&1',
                'if [[ "$?" -ne "0" ]]; then',
                '   exit 60',
                'fi',
                ''
            ].join('\n');

            vasync.forEachPipeline({
                inputs: [
                    {
                        str: nodeConfigCmd,
                        progbarName: 'Updating node.config',
                        timeout: 10 * 60 * 1000
                    },
                    {
                        str: downloadCmd,
                        progbarName: 'Downloading agentsshar',
                        timeout: 10 * 60 * 1000
                    },
                    {
                        str: installCmd,
                        progbarName: 'Installing agentsshar',
                        timeout: 20 * 60 * 1000
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
                        concurrency: options.rate,
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
                    sdcadm.log.trace(
                        {command: cmd.str, concurrency: options.rate},
                        'runUrQueue');

                    var rq = ur.runQueue(queueOpts, function (err, results) {
                        if (err) {
                            nextCmd(new errors.UpdateError(
                                err, 'unexpected runQueue error'));
                            return;
                        }

                        var errs = [];
                        results.forEach(function (r) {
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
                        // A non-zero exit from the command is a "success".
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
            }, function doneCmds(err, _) {
                next(err);
            });
        },

        function doCleanup(ctx, next) {
            if (justDownload || justUpdateSymlink) {
                next();
                return;
            }
            if (ctx.deleteAgentssharOnFinish) {
                progress('Deleting temporary %s', filepath);
                fs.unlink(filepath, function (err) {
                    if (err) {
                        sdcadm.log.warn(err, 'could not unlink %s', filepath);
                    }
                    next();
                });
            } else {
                next();
            }
        },

        // At this point we can consider the update complete. The next step
        // is just about providing accurate information when listing agent
        // instances and until we move from update agents using a shar file
        // to the individual agents update.
        function refreshSysinfo(ctx, next) {
            if (justDownload || justUpdateSymlink) {
                next();
                return;
            }

            progress('Reloading sysinfo on updated servers');

            var errs = [];

            var queue = vasync.queue(
                function upSysinfo(server, cb) {
                    sdcadm.cnapi.refreshSysinfoAndWait(
                        server.uuid,
                        sdcadm.config.wfapi.url,
                        {},
                        function cnapiCb(err, job) {
                        if (err) {
                            sdcadm.log.error({
                                err: err,
                                server: server
                            }, 'CNAPI sysinfo-refresh');
                            errs.push(server.uuid);
                        }
                        if (job && job.execution === 'failed') {
                            sdcadm.log.debug({
                                job: job,
                                server: server
                            }, 'CNAPI sysinfo-refresh job failed');

                        }
                        return cb();
                    });
                },
                10);

            queue.push(ctx.serversToUpdate); // No need for per task done cb
            queue.close();
            queue.on('end', function done() {
                if (errs.length) {
                    progress(
                        'Sysinfo reload failed for the following servers:');
                    errs.forEach(function (e) {
                        progress(common.indent(e));
                    });
                    progress(
                        'Please consider reviewing sysinfo for these servers');
                } else {
                    progress('Sysinfo reloaded for all the running servers');
                }
                next();
            });
        },

        /*
         * This is a HACK workaround for a possible race in config-agent
         * restarts. See TOOLS-1084. This doesn't actually fully close the
         * race.
         */
        function refreshConfigAgents(ctx, next) {
            if (justDownload || justUpdateSymlink) {
                next();
                return;
            }
            progress('Refreshing config-agent on all the updated servers');

            var queue = vasync.queue(
                function refreshCfgAgent(server, cb) {
                    svcadm.svcadmRefresh({
                        server_uuid: server.uuid,
                        wait: false,
                        fmri: 'config-agent',
                        sdcadm: sdcadm,
                        log: sdcadm.log
                    }, cb);
                },
                10);
            queue.push(ctx.serversToUpdate); // No need for per task done cb
            queue.close();
            queue.on('end', function done() {
                progress('Config-agent refreshed on updated servers');
                next();
            });
        },

        steps.noRabbitEnable

    ]}, function finishUpdateAgents(err) {
        if (err === true) { // early abort signal
            err = null;
        }
        if (justDownload || justUpdateSymlink) {
            callback(err);
            return;
        }
        if (!err) {
            progress('Successfully updated agents (%s)',
                    common.humanDurationFromMs(Date.now() - startTime));
        }
        callback(err);
    });
}


/*
 * Update agents in datancenter with a given or latest agents installer.
 */

function do_update_agents(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }
    if (!opts.latest && !args[0]) {
        cb(new errors.UsageError('must specify an AGENTSSHAR: ' +
            '--latest, an updates server UUID, or a download agentsshar ' +
            'package'));
        return;
    }

    var agentsshar = (!opts.latest) ? args.shift() : 'latest';
    var servers = args.length ? args : undefined;

    if (opts.all && servers) {
        cb(new errors.UsageError(
            'cannot specify "--all" and explicit servers: ' +
            servers.join(' ')));
        return;
    } else if (!opts.all && !servers && !opts.just_download &&
        !opts.just_update_symlink) {
        cb(new errors.UsageError(
            'either --all option or explicitly specifying ' +
            'SERVER(s) is required'));
        return;
    }

    vasync.pipeline({funcs: [
        function ensureSdcApp(_, next) {
            self.sdcadm.ensureSdcApp({}, function (err) {
                if (err) {
                    next(err);
                    return;
                }
                // Set or override the default channel if anything is given:
                if (opts.channel) {
                    self.sdcadm.updates.channel = opts.channel;
                }
                next();
            });
        },
        function runUpdateAgents(_, next) {
            updateAgents({
                sdcadm: self.sdcadm,
                agentsshar: agentsshar,
                progress: self.progress,
                justDownload: opts.just_download,
                skipLatestSymlink: opts.skip_latest_symlink,
                justUpdateSymlink: opts.just_update_symlink,
                yes: opts.yes,
                servers: servers,
                all: opts.all,
                concurrency: Number(opts.concurrency)
            }, next);
        }
    ]}, cb);

}
do_update_agents.help = (
    'Update GZ agents on servers in the DC.\n' +
    '\n' +
    'Usage:\n' +
    '    {{name}} update-agents [OPTIONS] AGENTSSHAR --all\n' +
    '    {{name}} update-agents [OPTIONS] AGENTSSHAR [SERVER ...]\n' +
    '    {{name}} update-agents [OPTIONS] AGENTSSHAR --just-download\n' +
    '\n' +
    '{{options}}' +
    '\n' +
    'Where AGENTSSHAR is one of "--latest" (the latest agentsshar package\n' +
    'in the current channel of the update server), an agentsshar UUID in\n' +
    'the updaes server, or a path to a locally downloaded agentsshar\n' +
    'package.\n' +
    '\n' +
    'Agents may only be updated on servers that are *setup*. Use "--all"\n' +
    'for all setup servers, or pass a specific set of SERVERs. A "SERVER"\n' +
    'is a server UUID or hostname. In a larger datacenter, getting a list\n' +
    'of the wanted servers can be a chore. The "sdc-server lookup ..." tool\n' +
    'is useful for this.\n' +
    '\n' +
    'Symlink to \'/usbkey/extra/agents/latest\' is modified to point to the\n' +
    'file downloaded unless "--skip-latest-symlink" option is given. (This \n' +
    'file is used to setup agents into new servers being setup).\n' +
    '\n' +
    'Examples:\n' +
    '    # Update to the latest agentsshar on all setup servers.\n' +
    '    {{name}} update-agents --latest --all\n' +
    '\n' +
    '    # Update a specific agentsshar on setup servers with the\n' +
    '    # "pkg=aegean" trait.\n' +
    '    {{name}} update-agents 8198c6c0-778c-11e5-8416-13cb06970b44 \\\n' +
    '        $(sdc-server lookup setup=true traits.pkg=aegean)\n' +
    '\n' +
    '    # Update on setup servers, excluding those with a\n' +
    '    # "internal=PKGSRC" trait.\n' +
    '    {{name}} update-agents 8198c6c0-778c-11e5-8416-13cb06970b44 \\\n' +
    '        $(sdc-server lookup setup=true \'traits.internal!~PKGSRC\')\n'
);
do_update_agents.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['latest'],
        type: 'bool',
        help: 'Update using the last published agents installer.'
    },
    {
        names: ['just-download'],
        type: 'bool',
        help: 'Download the agents installer for later usage.'
    },
    {
        names: ['skip-latest-symlink'],
        type: 'bool',
        help: 'Do not modify the file pointed at by ' +
            '\'/usbkey/extra/agents/latest\' symlink.'
    },
    {
        names: ['just-update-symlink'],
        type: 'bool',
        help: 'Only update \'/usbkey/extra/agents/latest\' ' +
            'to the given file path.'
    },
    {
        names: ['all', 'a'],
        type: 'bool',
        help: 'Update on all setup servers.'
    },
    {
        names: ['yes', 'y'],
        type: 'bool',
        help: 'Answer yes to all confirmations.'
    },
    {
        names: ['concurrency', 'j'],
        type: 'integer',
        'default': 5,
        help: 'Number of concurrent servers downloading agentsshar file or ' +
            'being updated simultaneously. Default: 5',
        helpArg: 'N'
    },
    {
        names: ['channel', 'C'],
        type: 'string',
        help: 'Use the given channel to fetch the image, even if it is ' +
            'not the default one.'
    }
];

// --- exports

module.exports = {
    do_update_agents: do_update_agents
};
