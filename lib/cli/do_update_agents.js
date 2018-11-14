/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */
'use strict';

/*
 * The 'sdcadm experimental update-agents' CLI subcommand.
 */

const fs = require('fs');
const path = require('path');
const util = require('util');

var assert = require('assert-plus');
const crypto = require('crypto');
const mkdirp = require('mkdirp');
const uuid = require('node-uuid');
const vasync = require('vasync');
const ProgressBar = require('progbar').ProgressBar;
const VError = require('verror');

const common = require('../common');
const errors = require('../errors');
const steps = require('../steps');
const svcadm = require('../svcadm');


function sha1Path(filePath, cb) {
    const hash = crypto.createHash('sha1');
    const s = fs.createReadStream(filePath);
    s.on('data', function onData(d) {
        hash.update(d);
    });
    s.on('end', function onEnd() {
        cb(null, hash.digest('hex'));
    });
}


/*
 * Fetch a given agent installer image (or if desired, latest), download it,
 * then deploy it on the selected servers.
 *
 * @param opts.agentsshar {String} A string indicating the agentsshar to
 *      which to update. This is the string 'latest', an updates server UUID, or
 *      a path to a locally downloaded agentsshar.
 * @param opts.all {Boolean} Update on all setup servers.
 *      One of `opts.all` or `opts.servers` must be specified.
 * @param opts.servers {Array} Array of server hostnames or UUIDs on which
 *      to update. One of `opts.all` or `opts.servers` must be specified.
 * ...
 *
 * TODO: finish documenting
 */
function UpdateAgents(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.string(opts.agentsshar, 'opts.agentsshar');
    assert.number(opts.concurrency, 'opts.concurrency');
    assert.optionalBool(opts.justDownload, 'opts.justDownload');
    assert.optionalBool(opts.skipLatestSymlink,
        'opts.skipLatestSymlink');
    assert.optionalBool(opts.justUpdateSymlink,
        'opts.justUpdateSymlink');
    assert.optionalBool(opts.yes, 'opts.yes');
    assert.optionalBool(opts.all, 'opts.all');
    assert.optionalArrayOfString(opts.servers, 'opts.servers');
    assert.func(opts.progress, 'opts.progress');

    if ((opts.all && opts.servers) ||
        (!opts.all && !opts.servers &&
         !opts.justDownload && !opts.justUpdateSymlink)) {
        throw new errors.UsageError(
            'must specify exactly one of "opts.all" or "opts.servers"');
    }

    this.downloadDir = '/var/tmp';

    this.agentsshar = opts.agentsshar;
    this.all = opts.all;
    this.concurrency = opts.concurrency;
    this.justDownload = opts.justDownload;
    this.justUpdateSymlink = opts.justUpdateSymlink;
    this.log = opts.sdcadm.log;
    this.progress = opts.progress;
    this.sdcadm = opts.sdcadm;
    this.servers = opts.servers;
    this.skipLatestSymlink = opts.skipLatestSymlink;
    this.yes = opts.yes;
}

UpdateAgents.prototype._setImageToLatest =  function _setImageToLatest(cb) {
    assert.func(cb, 'cb');
    assert.string(this.channel, 'this.channel');

    const self = this;
    const filter = {
        name: 'agentsshar'
    };
    this.progress(
        'Finding latest "agentsshar" on updates server (channel "%s")',
        this.channel);
    this.sdcadm.updates.listImages(filter, function (err, images) {
        if (err) {
            cb(new errors.SDCClientError(err, 'updates'));
            return;
            }
        if (Array.isArray(images) && !images.length) {
            cb(new errors.UpdateError('no images found'));
            return;
        }
        common.sortArrayOfObjects(images, ['published_at']);
        self.image = images[images.length - 1];
        self.progress('Latest is agentsshar %s (%s)',
                      self.image.uuid, self.image.version);
        cb();
    });
};

UpdateAgents.prototype._setImageFromUuid =
function _setImageFromUuid(imageUuid, cb) {
    assert.uuid(imageUuid, 'imageUuid');
    assert.func(cb, 'cb');

    const self = this;

    this.sdcadm.updates.getImage(imageUuid, function (err, foundImage) {
        if (err) {
            cb(new errors.SDCClientError(err, 'updates'));
            return;
            }
        self.image = foundImage;
        self.progress('Found agentsshar %s (%s)',
                      self.image.uuid, self.image.version);
        cb();
    });
};


UpdateAgents.prototype._stepVerifyFilepath =
function _stepVerifyFilepath(_, next) {
    assert.func(next, 'next');

    if (!this.justUpdateSymlink) {
        next();
        return;
    }
    if (!this.filepath) {
        next(new Error('existing file must be specified when using ' +
                       '"--just-update-symlink" option'));
        return;
    }
    next();
};


/*
 * If we are about to download an image, first check to see if that
 * image is already available locally (verifying via checksum).
 * If so, then switch to using that file.
 */
UpdateAgents.prototype._stepHaveSharAlreadyFromLink =
function _stepHaveSharAlreadyFromLink(_, next) {
    assert.func(next, 'next');

    const self = this;

    if (self.filepath) {
        next();
        return;
    }

    // lla == "Latest Local Agentsshar"
    const llaLink = '/usbkey/extra/agents/latest';
    fs.exists(llaLink, function (exists) {
        if (!exists) {
            self.log.debug({llaLink: llaLink}, 'symlink to latest ' +
                           'agentsshar is missing, skipping shortcut');
            next();
            return;
        }
        fs.readlink(llaLink, function (err, linkTarget) {
            if (err) {
                self.log.error({err: err, llaLink: llaLink},
                               'could not read agents "latest" symlink');
                next(new errors.UpdateError(
                    err,
                    'could not read agents "latest" symlink, ' +
                        llaLink));
                return;
            }

            const llaPath = path.resolve(
                path.dirname(llaLink), linkTarget);
            self.log.debug({llaPath: llaPath}, 'latest local agentsshar');
            sha1Path(llaPath, function (checksumErr, checksum) {
                if (checksumErr) {
                    next(checksumErr);
                    return;
                }
                if (checksum === self.image.files[0].sha1) {
                    self.progress('The %s agentsshar already exists ' +
                                  'at %s, using it', self.agentsshar,
                                  llaPath);
                    self.filepath = llaPath;
                }
                next();
            });
        });
    });
};

UpdateAgents.prototype._stepHaveSharAlreadyFromDownload =
function _stepHaveSharAlreadyFromDownload(_, next) {
    assert.func(next, 'next');

    const self = this;

    if (self.filepath) {
        next();
        return;
    }

    const predownloadedPath = path.resolve(self.downloadDir,
                                           'agents-' + self.image.uuid + '.sh');
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
            if (checksum === self.image.files[0].sha1) {
                self.progress('The %s agentsshar already exists ' +
                              'at %s, using it', self.agentsshar,
                              predownloadedPath);
                self.filepath = predownloadedPath;
            }
            next();
        });
    });
};

UpdateAgents.prototype._stepCreateLatestSymlink =
function _stepCreateLatestSymlink(ctx, next) {
    assert.func(next, 'next');

    const self = this;

    if (self.justDownload || self.skipLatestSymlink) {
        next();
        return;
    }

    const symlink = '/usbkey/extra/agents/latest';
    self.progress('Create %s symlink', symlink);
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
};

UpdateAgents.prototype._stepDownloadAgentsshar =
function _stepDownloadAgentsshar(ctx, next) {
    assert.func(next, 'next');

    const self = this;

    if (self.filepath) {
        next();
        return;
    }
    self.filepath = path.resolve(self.downloadDir,
                                 'agents-' + self.image.uuid + '.sh');
    ctx.deleteAgentssharOnFinish = true;
    self.progress('Downloading agentsshar from updates server ' +
                  '(channel "%s")\n    to %s', self.channel, self.filepath);
    self.sdcadm.updates.getImageFile(
        self.image.uuid, self.filepath,
        function (err) {
            if (err) {
                next(new errors.SDCClientError(err, 'updates'));
            } else {
                next();
            }
        });
};


UpdateAgents.prototype.exec = function exec(callback) {
    assert.func(callback, 'callback');

    const self = this;
    let startTime = Date.now();

    this.filepath = null;
    this.channel = null;
    this.image = null;

    const context = {
        log: self.log,
        progress: self.progress,
        sdcadm: self.sdcadm,
        urconn: null
    };

    vasync.pipeline({arg: context, funcs: [
        /*
         * Check for Ur availability first, as we cannot proceed without
         * it:
         */
        process.abort,
        /* XXX RABBIT
        function urDiscoveryGetReady(ctx, next) {
            if (self.justDownload || self.justUpdateSymlink) {
                next();
                return;
            }

            self.sdcadm.getUrConnection(function (err, urconn) {
                if (err) {
                    self.log.debug({
                        err: err
                    }, 'ur error');
                    next(new errors.InternalError({
                        cause: err,
                        message: 'ur not available (check RabbitMQ)'
                    }));
                    return;
                }

                self.log.debug('ur connected');
                ctx.urconn = urconn;
                next();
            });
        },
        */

        function getChannelIfNeeded(_, next) {
            if (self.agentsshar === 'latest' ||
                common.UUID_RE.test(self.agentsshar)) {
                self.sdcadm.getDefaultChannel(function (err, ch) {
                    self.channel = ch;
                    next(err);
                });
            } else {
                next();
            }
        },

        function setImageOrFilepath(_, next) {
            if (self.agentsshar === 'latest') {
                self._setImageToLatest(next);
            } else if (common.UUID_RE.test(self.agentsshar)) {
                self._setImageFromUuid(self.agentsshar, next);
            } else if (fs.existsSync(self.agentsshar)) {
                self.filepath = self.agentsshar;
                next();
            } else {
                next(new Error(
                    util.format('could not find agentsshar: "%s" is ' +
                                'not a UUID or an existing file',
                                self.agentsshar)));
            }
        },

        self._stepVerifyFilepath.bind(self),
        self._stepHaveSharAlreadyFromLink.bind(self),
        self._stepHaveSharAlreadyFromDownload.bind(self),

        function listServers(ctx, next) {
            if (self.justDownload || self.justUpdateSymlink) {
                next();
                return;
            }
            self.progress('Finding servers to update');
            // Get all servers to validate if unsetup servers are selected.
            self.sdcadm.cnapi.listServers({}, function (err, servers) {
                if (err) {
                    next(err);
                    return;
                }
                ctx.allServers = servers;
                next();
            });
        },

        function findServersToUpdate(ctx, next) {
            if (self.justDownload || self.justUpdateSymlink) {
                next();
                return;
            }

            if (self.all) {
                ctx.serversToUpdate = ctx.allServers.filter(function (svr) {
                    return svr.setup;
                });
                next();
            } else {
                let i, s;
                const serverFromUuid = {};
                const serverFromHostname = {};
                for (i = 0; i < ctx.allServers.length; i++) {
                    s = ctx.allServers[i];
                    serverFromUuid[s.uuid] = s;
                    serverFromHostname[s.hostname] = s;
                }

                ctx.serversToUpdate = [];
                const serverToUpdateFromUuid = {};
                const unsetupServerIds = [];
                const notFoundServerIds = [];
                for (i = 0; i < self.servers.length; i++) {
                    const id = self.servers[i];
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
                    next(new Error(util.format(
                        '%d of %d selected servers were not found in CNAPI: %s',
                        notFoundServerIds.length, self.servers.length,
                        notFoundServerIds.join(', '))));
                } else if (unsetupServerIds.length) {
                    next(new Error(util.format(
                        '%d of %d selected servers are not setup: %s',
                        unsetupServerIds.length, self.servers.length,
                        unsetupServerIds.join(', '))));
                } else {
                    next();
                }
            }
        },

        process.abort,
        /* XXX RABBIT
        function urDiscovery(ctx, next) {
            if (self.justDownload || self.justUpdateSymlink) {
                next();
                return;
            }

            common.urDiscovery({
                sdcadm: self.sdcadm,
                progress: self.progress,
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
        */


        function earlyAbortForJustDownload(_, next) {
            if (self.justDownload && self.filepath) {
                self.progress('Agentsshar is already downloaded to %s',
                              self.filepath);
                next(true); // early abort signal
            } else {
                next();
            }
        },

        function confirm(ctx, next) {
            self.progress('\nThis update will make the following changes:');
            self.progress(
                common.indent('Ensure core agent SAPI services exist'));
            if (!self.filepath) {
                assert.object(self.image, 'self.image');
                self.progress(common.indent(util.format(
                    'Download agentsshar %s\n    (%s)',
                    self.image.uuid, self.image.version)));
            }
            if (!self.justDownload && !self.justUpdateSymlink) {
                self.progress(common.indent(util.format(
                    'Update GZ agents on %d (of %d) servers using\n' +
                    '    agentsshar %s', ctx.serversToUpdate.length,
                    ctx.allServers.length,
                    (self.filepath ? self.filepath : self.image.version))));
            }
            if (self.justUpdateSymlink && self.filepath) {
                self.progress(common.indent(util.format('Update ' +
                    '\'/usbkey/extra/agents/latest\' symkink to %s',
                    self.filepath)));
            }
            self.progress('');
            if (self.yes) {
                next();
                return;
            }
            const msg = 'Would you like to continue? [y/N] ';
            common.promptYesNo({msg: msg, default: 'n'}, function (answer) {
                if (answer !== 'y') {
                    self.progress('Aborting agents update');
                    callback();
                    return;
                }
                self.progress('');
                startTime = Date.now(); // Reset to not count confirm time.
                next();
            });
        },

        steps.sapi.ensureAgentServices,
        self._stepDownloadAgentsshar.bind(self),

        function copyFileToAssetsDir(_, next) {
            if (self.justDownload) {
                next();
                return;
            }
            const assetsdir = '/usbkey/extra/agents';
            if (path.dirname(self.filepath) === assetsdir) {
                next();
                return;
            }
            self.progress('Copy agentsshar to assets dir: %s', assetsdir);
            const argv = ['cp', self.filepath, assetsdir];
            mkdirp.sync(assetsdir);
            common.execFilePlus({
                argv: argv,
                log: self.sdcadm.log
            }, function (err, stderr, stdout) {
                self.sdcadm.log.trace({
                    cmd: argv.join(' '),
                    err: err,
                    stdout: stdout,
                    stderr: stderr
                }, 'ran cp command');
                if (err) {
                    next(new errors.InternalError({
                        message: util.format('error copying shar file to %s',
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
            ctx.fname = path.basename(self.filepath);
            next();
        },

        self._stepCreateLatestSymlink.bind(self),

        function removeOldAgentsShars(ctx, next) {
            if (self.justDownload || self.justUpdateSymlink ||
                self.skipLatestSymlink) {
                next();
                return;
            }
            steps.usbkey.removeOldAgentsShars(ctx, next);
        },

        function updateCNAgents(ctx, next) {
            if (self.justDownload || self.justUpdateSymlink) {
                next();
                return;
            }

            self.progress('Starting agentsshar update on %d servers',
                ctx.urServersToUpdate.length);

            const ip = self.sdcadm.config.assets_admin_ip;
            const f = ctx.fname;
            const ff = '/var/tmp/' + f;
            // Do not override log file if we run installer more than once for
            // the same version.
            // TODO(trent): Won't these build up? Should clean these out.
            const lf = '/var/tmp/' + f + '_' + uuid() + '_install.log';
            const nodeConfigCmd = [
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

            const downloadCmd = [
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

            const installCmd = [
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
                // XXX RABBIT
                func: function runUrQueue(cmd, nextCmd) {
                    process.abort();
                    // XXX RABBIT assert.object(ctx.urconn, 'ctx.urconn');
                    const queueOpts = {
                        sdcadm: self.sdcadm,
                        // XXX RABBIT urConnection: ctx.urconn,
                        log: self.sdcadm.log,
                        progress: self.progress,
                        command: cmd.str,
                        concurrency: self.concurrency,
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
                    /* XXX RABBIT
                    self.sdcadm.log.trace(
                        {command: cmd.str, concurrency: self.concurrency},
                        'runUrQueue');
                        */

                    /*
                     * XXX RABBIT
                    var rq = ur.runQueue(queueOpts, function (err, results) {
                        if (err) {
                            nextCmd(new errors.UpdateError(
                                err, 'unexpected runQueue error'));
                            return;
                        }

                        var errs = [];
                        results.forEach(function (r) {
                            if (r.error || r.result.exit_status !== 0) {
                                errs.push(new errors.UpdateError(util.format(
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
                            var errmsg = util.format(
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
                    */
                }
            }, function doneCmds(err, _) {
                next(err);
            });
        },

        function doCleanup(ctx, next) {
            if (self.justDownload || self.justUpdateSymlink) {
                next();
                return;
            }
            if (ctx.deleteAgentssharOnFinish) {
                self.progress('Deleting temporary %s', self.filepath);
                fs.unlink(self.filepath, function (err) {
                    if (err) {
                        self.sdcadm.log.warn(err, 'could not unlink %s',
                                             self.filepath);
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
            if (self.justDownload || self.justUpdateSymlink) {
                next();
                return;
            }

            self.progress('Reloading sysinfo on updated servers');

            const errs = [];

            const queue = vasync.queue(
                function upSysinfo(server, cb) {
                    self.sdcadm.cnapi.refreshSysinfoAndWait(
                        server.uuid,
                        self.sdcadm.config.wfapi.url,
                        {},
                        function cnapiCb(err, job) {
                        if (err) {
                            self.sdcadm.log.error({
                                err: err,
                                server: server
                            }, 'CNAPI sysinfo-refresh');
                            errs.push(server.uuid);
                        }
                        if (job && job.execution === 'failed') {
                            self.sdcadm.log.debug({
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
                    self.progress(
                        'Sysinfo reload failed for the following servers:');
                    errs.forEach(function (e) {
                        self.progress(common.indent(e));
                    });
                    self.progress(
                        'Please consider reviewing sysinfo for these servers');
                } else {
                    self.progress(
                        'Sysinfo reloaded for all the running servers');
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
            if (self.justDownload || self.justUpdateSymlink) {
                next();
                return;
            }
            self.progress('Refreshing config-agent on all the updated servers');

            const queue = vasync.queue(
                function refreshCfgAgent(server, cb) {
                    svcadm.svcadmRefresh({
                        server_uuid: server.uuid,
                        wait: false,
                        fmri: 'config-agent',
                        sdcadm: self.sdcadm,
                        log: self.sdcadm.log
                    }, cb);
                },
                10);
            queue.push(ctx.serversToUpdate); // No need for per task done cb
            queue.close();
            queue.on('end', function done() {
                self.progress('Config-agent refreshed on updated servers');
                next();
            });
        },

        steps.noRabbit.noRabbitEnable

    ]}, function finishUpdateAgents(err) {
        if (err === true) { // early abort signal
            err = null;
        }
        if (self.justDownload || self.justUpdateSymlink) {
            callback(err);
            return;
        }
        if (!err) {
            self.progress('Successfully updated agents (%s)',
                    common.humanDurationFromMs(Date.now() - startTime));
        }
        callback(err);
    });
};


/**
 * Update agents in datancenter with a given or latest agents installer.
 * @this Cmdln
 */
function do_update_agents(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        self.do_help('help', {}, [subcmd], cb);
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
            const cmd = new UpdateAgents({
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
            });
            cmd.exec(next);
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

do_update_agents.logToFile = true;

// --- exports

module.exports = {
    do_update_agents: do_update_agents,
    _UpdateAgents: UpdateAgents,
    _sha1Path: sha1Path
};
