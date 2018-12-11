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
const ur = require('../ur');


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

    var self = this;

    if ((opts.all && opts.servers) ||
        (!opts.all && !opts.servers &&
         !opts.justDownload && !opts.justUpdateSymlink)) {
        throw new errors.UsageError(
            'must specify exactly one of "opts.all" or "opts.servers"');
    }

    self.excludeServers = opts.exclude || [];

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


function failedUnsetup(server, ctx, progress) {
    var msg = util.format('server %s (%s) is not setup',
        server.uuid, server.hostname);

    ctx.failedUpdates.push(new Error(msg));
    progress('Warning: ' + msg + ', skipping');
}

function failedUrBroadcast(server, ctx, progress) {
    var msg = util.format(
        'server %s (%s) did not reply to Ur broadcast',
        server.uuid, server.hostname);

    ctx.failedUpdates.push(new Error(msg));
    progress('Warning: ' + msg + ', skipping');
}

function failedMissing(id, ctx, progress) {
    var msg = util.format('server %s does not exist', id);

    ctx.failedUpdates.push(new Error(msg));
    progress('Warning: ' + msg + ', skipping');
}

//
// Generates a chunk of bash code that does some very basic locking to prevent
// the most likely cases where we might have multiple updates trying to run at
// the same time. Important: this is not fully race-free, but it's likely good
// enough to catch the situation where an update is running and someone loses
// their connection to sdcadm and tries to run again.
//
function generateLockSh(command, filename) {
    var lines = [
        'LOCKFILE="/var/tmp/lock.' + filename + '.' + command + '.pid"',
        '',
        'if ! (set -o noclobber; echo "$$" > $LOCKFILE); then',
        '    RUNNING_PID=$(cat $LOCKFILE)',
        '    if kill -0 $RUNNING_PID; then',
        '        echo "' + command +
            ' already running with PID $RUNNING_PID" >&2',
        '        exit 40',
        '    else',
        '        echo "stale ' + command + ' detected, removing lock and ' +
            'trying again" >&2',
        '        rm -f $LOCKFILE',
        '        if ! (set -o noclobber; echo "$$" > $LOCKFILE); then',
        '            echo "unable to acquire lock" >&2',
        '            exit 45',
        '        fi',
        '        echo "took over lock" >&2',
        '    fi',
        'fi',
        '',
        '# Delete lockfile when this process exits',
        'trap "rm -f $LOCKFILE" EXIT'
    ];

    return lines.join('\n');
}


UpdateAgents.prototype.exec = function exec(callback) {
    assert.func(callback, 'callback');

    const self = this;
    let startTime = Date.now();

    this.filepath = null;
    this.channel = null;
    this.image = null;

    const context = {
        failedUpdates: [],
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
        function urClientInit(ctx, next) {
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
                ctx.allServers = servers.map(function _mapServer(s) {
                    // Just keep those parameters we care about (the same ones
                    // that urclient keeps from a sysinfo broadcast reply).
                    return {
                        headnode: s.headnode,
                        hostname: s.hostname,
                        setup: s.setup,
                        status: s.status,
                        transitional_status: s.transitional_status,
                        uuid: s.uuid
                    };
                });
                next();
            });
        },

        function findServersToUpdate(ctx, next) {
            const unsetupServerIds = [];
            const notFoundServerIds = [];
            let i, s;
            ctx.excludedServers = [];
            ctx.serverFromUuid = {};
            ctx.serverFromHostname = {};

            if (self.justDownload || self.justUpdateSymlink) {
                next();
                return;
            }

            // Make 2 mappings so that user can specify a uuid or hostname
            // and we can find that server.
            for (i = 0; i < ctx.allServers.length; i++) {
                s = ctx.allServers[i];
                ctx.serverFromUuid[s.uuid] = s;
                ctx.serverFromHostname[s.hostname] = s;
            }

            if (self.all) {
                // Remove only servers that aren't setup or are excluded.
                ctx.serversToUpdate = ctx.allServers.filter(function (srv) {
                    if (!srv.setup) {
                        failedUnsetup(srv, ctx, self.progress);
                    }
                    if (self.excludeServers.indexOf(srv.hostname) !== -1 ||
                        self.excludeServers.indexOf(srv.uuid) !== -1) {

                        self.progress(util.format('Info: server %s (%s) was ' +
                            'excluded on cmdline, skipping',
                            srv.uuid, srv.hostname));
                        ctx.excludedServers.push(srv.uuid);
                        return false;
                    }
                    return srv.setup;
                });
                next();
            } else {

                ctx.serversToUpdate = [];
                const serverToUpdateFromUuid = {};

                // Go through the list of servers the user specified and record
                // any that were not found or not setup.
                for (i = 0; i < self.servers.length; i++) {
                    const id = self.servers[i];
                    s = ctx.serverFromUuid[id] || ctx.serverFromHostname[id];
                    if (s) {
                        // Avoid drop dupes in `opts.servers`.
                        if (!serverToUpdateFromUuid[s.uuid]) {
                            ctx.serversToUpdate.push(s);
                            serverToUpdateFromUuid[s.uuid] = true;
                        }
                        if (!s.setup) {
                            failedUnsetup(s, ctx, self.progress);
                            unsetupServerIds.push(id);
                        }
                    } else {
                        failedMissing(id, ctx, self.progress);
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

        function urDiscovery(ctx, next) {
            if (self.justDownload || self.justUpdateSymlink) {
                next();
                return;
            }

            common.urDiscovery({
                logMissingNodes: false,
                sdcadm: self.sdcadm,
                progress: self.progress,
                nodes: ctx.serversToUpdate.map(
                    function (s) { return s.uuid; }),
                urconn: ctx.urconn
            }, function (err, urAvailServers) {
                let i;

                if (err && err.message === 'could not find all nodes') {
                    // This is a hack but urclient doesn't seem to give us a
                    // better way to deal with this.
                    for (i = 0; i < err.nodes_missing.length; i++) {
                        failedUrBroadcast(
                            ctx.serverFromUuid[err.nodes_missing[i]], ctx,
                            self.progress);
                    }

                    ctx.urServersToUpdate = ctx.serversToUpdate.filter(
                        function _filterUrAvailableServers(s) {
                            // Only keep servers that are *not* in the
                            // missing list.
                            return (err.nodes_missing.indexOf(s.uuid) === -1);
                        });

                    next();
                    return;
                } else if (err) {
                    next(err);
                    return;
                }

                ctx.urServersToUpdate = urAvailServers;
                next();
            });
        },

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
                    '    agentsshar %s', ctx.urServersToUpdate.length,
                    ctx.allServers.length,
                    (self.filepath ? self.filepath : self.image.version))));
            }
            if (self.justUpdateSymlink && self.filepath) {
                self.progress(common.indent(util.format('Update ' +
                    '\'/usbkey/extra/agents/latest\' symlink to %s',
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

        function copyFileToAssetsDir(ctx, next) {
            const assetsdir = '/usbkey/extra/agents';
            ctx.fname = path.basename(self.filepath);
            ctx.absfname = path.join(assetsdir, ctx.fname);

            if (self.justDownload) {
                next();
                return;
            }
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
            }, function (err, stdout, stderr) {
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

        function getSharSha1(ctx, next) {
            var argv = [
                '/usr/bin/openssl',
                'dgst', '-r', '-sha1',
                ctx.absfname
            ];

            common.execFilePlus({
                argv: argv,
                log: self.sdcadm.log
            }, function (err, stdout, stderr) {
                var sha1;

                self.sdcadm.log.trace({
                    cmd: argv.join(' '),
                    err: err,
                    stdout: stdout,
                    stderr: stderr
                }, 'ran openssl command');

                if (err) {
                    next(new errors.InternalError({
                        message: util.format('unable to find SHA1 of %s',
                            ctx.absfname),
                        cmd: argv.join(' '),
                        stdout: stdout,
                        stderr: stderr,
                        cause: err
                    }));
                    return;
                }

                sha1 = stdout.trim().split(' ')[0];

                if (sha1.length !== 40) {
                    next(new errors.InternalError({
                        message: 'unexpected SHA1 output',
                        cmd: argv.join(' '),
                        stdout: stdout,
                        stderr: stderr
                    }));
                    return;
                }

                ctx.sha1 = sha1;

                next();
            });
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
                '    mv /var/tmp/node.config/node.config ' +
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
                '       echo "failed to download new node.config" >&2',
                '       exit 33',
                '   fi',
                '',
                /*
                 * Exit non zero if config dir does not exist
                 */
                '   if [[ ! -d  /opt/smartdc/config && -z "$IS_CN" ]]; then',
                '       echo "missing /opt/smartdc/config" >&2',
                '       exit 44',
                '   fi',
                '',
                '   /usr/bin/cp /var/tmp/node.config/node.config ' +
                    '/opt/smartdc/config/',
                'fi',
                '',
                'echo "replaced node.config" >&2',
                ''
            ].join('\n');

            const downloadCmd = [
                'OUTFILE="/var/tmp/' + f + '"',
                '',
                'cd /var/tmp;',
                '',
                generateLockSh('download', f),
                '',
                'EXPECTED_SHA1="' + ctx.sha1 + '"',
                '',
                /*
                 * Exit non zero if agents dir does not exist
                 */
                'if [[ ! -d  /opt/smartdc/agents/lib ]]; then',
                '    echo "missing /opt/smartdc/agents/lib" >&2',
                '    exit 50',
                'fi',
                '',
                'if [[ -f $OUTFILE ]]; then',
                '    ACTUAL_SHA1=$(/usr/bin/openssl dgst -r -sha1 $OUTFILE' +
                    ' | cut -d\' \' -f1)',
                '    if [[ $EXPECTED_SHA1 == $ACTUAL_SHA1 ]]; then',
                '        echo "already downloaded" >&2',
                '        exit 0',
                '    fi',
                'fi',
                '',
                /*
                 * Exit 22 if cannot download the installer file (curl code)
                 */
                '/usr/bin/curl -kOsf http://' + ip + '/extra/agents/' + f,
                'if [[ "$?" -ne "0" ]]; then',
                '   echo "failed to download shar" >&2',
                '   exit $?',
                'fi',
                '',
                'ACTUAL_SHA1=$(/usr/bin/openssl dgst -r -sha1 $OUTFILE' +
                    ' | cut -d\' \' -f1)',
                'if [[ $EXPECTED_SHA1 != $ACTUAL_SHA1 ]]; then',
                '    echo "invalid sha1 after download" >&2',
                '    exit 55',
                'fi',
                '',
                'echo "successfully downloaded" >&2',
                ''
            ].join('\n');

            const installCmd = [
                'SHARFILE="/var/tmp/' + f + '"',
                '',
                'cd /var/tmp;',
                '',
                generateLockSh('install', f),
                '',
                'NEW_SHA1="' + ctx.sha1 + '"',
                '',
                '#',
                '# This errs on the side of assuming we need to update, since',
                '# updating when we do not need to is better than refusing to',
                '# update when we do. If the file is missing or does not match',
                '# exactly what we expect, we will update. If something goes',
                '# really wrong, an operator can just delete the',
                '# agentsshar.sha1 file and the update will proceed.',
                '#',
                'if [[ -f /opt/smartdc/agents/etc/agentsshar.sha1 ]]; then',
                '    PREV_SHA1=$(cat /opt/smartdc/agents/etc/agentsshar.sha1)',
                '    if [[ $NEW_SHA1 == $PREV_SHA1 && -f ' +
                    '/opt/smartdc/agents/etc/agentsshar.post ]]; then',
                '        find /opt/smartdc/agents/lib/node_modules/*/ ' +
                    '-name "image_uuid" -maxdepth 1 -print -exec cat {} \\; ' +
                    '> /var/tmp/' + f + '.prevagents',
                '        if cmp /var/tmp/' + f + '.prevagents ' +
                    '/opt/smartdc/agents/etc/agentsshar.post; then',
                '            rm -f /var/tmp/' + f + '.prevagents',
                '            echo "already updated" >&2',
                '            exit 0',
                '        fi',
                '        rm -f /var/tmp/' + f + '.prevagents',
                '        echo "agents updated since last shar, proceeding" >&2',
                '    fi',
                'fi',
                '',
                /*
                 * Exit 60 if installer fails
                 */
                '/usr/bin/bash ' + ff + ' </dev/null >' + lf + ' 2>&1',
                'if [[ "$?" -ne "0" ]]; then',
                '   echo "failed to install agentsshar" >&2',
                '   exit 60',
                'fi',
                '',
                '#',
                '# Keep track of what versions are installed now and what the',
                '# SHA1 of this shar was, so we know that we can skip the next',
                '# update for the same shar if nothing else has changed in the',
                '# meantime.',
                '#',
                'mkdir -p /opt/smartdc/agents/etc',
                'find /opt/smartdc/agents/lib/node_modules/*/ ' +
                    '-name "image_uuid" -maxdepth 1 -print -exec cat {} \\; ' +
                    '> /opt/smartdc/agents/etc/agentsshar.post',
                'echo "' + ctx.sha1 +
                    '" > /opt/smartdc/agents/etc/agentsshar.sha1',
                'echo "updated" >&2',
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
                    const queueOpts = {
                        sdcadm: self.sdcadm,
                        urConnection: ctx.urconn,
                        log: self.sdcadm.log,
                        progress: self.progress,
                        command: cmd.str,
                        concurrency: self.concurrency,
                        onCompletionFunc: _onCompletion,
                        timeout: cmd.timeout
                    };

                    var bar;

                    // This will get called for either success or failure. On
                    // failure (what urclient considers failure) we'll have
                    // result.error as an error object.
                    function _onCompletion(server, result) {
                        var failed = false;
                        var logger;
                        var msg;
                        var stderrLines;

                        if (result.error) {
                            msg = util.format('error (%s)',
                                result.error.message);
                            failed = true;
                        } else if (result.exit_status !== 0) {
                            // We "succeeded" as far as urclient is concerned,
                            // because the script ran. But the script returned
                            // a non-zero exit code.
                            failed = true;
                            stderrLines = result.stderr.trim().split('\n');
                            msg = util.format('error (%s)',
                                stderrLines[stderrLines.length - 1] ||
                                'failed with exit status ' +
                                result.exit_status);
                        } else {
                            stderrLines = result.stderr.trim().split('\n');
                            msg = stderrLines[stderrLines.length - 1] ||
                                'success';
                        }

                        if (failed) {
                            // We failed what we were trying to do, so we will
                            // remove it from the list so that we do not try
                            // anything else on this server.
                            ctx.urServersToUpdate =
                                ctx.urServersToUpdate.filter(
                                    function _removeFailed(s) {
                                        return (s.uuid !== server.uuid);
                                    });
                        }

                        if (bar) {
                            logger = bar;
                        } else {
                            logger = console;
                        }
                        logger.log(util.format('Server %s (%s): %s',
                            server.uuid, server.hostname, msg));
                    }

                    if (process.stderr.isTTY) {
                        bar = new ProgressBar({
                            size: ctx.urServersToUpdate.length,
                            bytes: false,
                            filename: cmd.progbarName
                        });
                        queueOpts.progbar = bar;
                    }
                    self.sdcadm.log.trace(
                        {command: cmd.str, concurrency: self.concurrency},
                        'runUrQueue');

                    var rq = ur.runQueue(queueOpts, function (err, results) {
                        if (err) {
                            nextCmd(new errors.UpdateError(
                                err, 'unexpected runQueue error'));
                            return;
                        }

                        results.forEach(function (r) {
                            if (r.error || r.result.exit_status !== 0) {
                                ctx.failedUpdates.push(
                                    new errors.UpdateError(util.format(
                                        '%s failed on server %s (%s): %j',
                                        cmd.progbarName, r.uuid, r.hostname,
                                        r.error || r.result)));
                            }
                        });

                        nextCmd();
                    });

                    rq.start();
                    ctx.urServersToUpdate.forEach(function (us) {
                        rq.add_server(us);
                    });
                    rq.close();
                }
            }, next);
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

            // If no updates succeeded, no point reloading sysinfo.
            if (ctx.urServersToUpdate.length === 0) {
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

            queue.push(ctx.urServersToUpdate); // No need for per task done cb
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

            // If no updates succeeded, no point refreshing config-agent.
            if (ctx.urServersToUpdate.length === 0) {
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
            queue.push(ctx.urServersToUpdate); // No need for per task done cb
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

        if (err || self.justDownload || self.justUpdateSymlink) {
            callback(err);
            return;
        }

        self.progress(
            'Updated agents on %d/%d servers (%d failures, %d excluded) (%s)',
            context.urServersToUpdate.length, context.allServers.length,
            context.failedUpdates.length, context.excludedServers.length,
            common.humanDurationFromMs(Date.now() - startTime));

        if (context.failedUpdates.length > 0) {
            callback(new errors.MultiError(context.failedUpdates));
            return;
        }

        callback();
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
                exclude: opts.exclude,
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
        names: ['exclude', 'x'],
        type: 'arrayOfCommaSepString',
        help: 'Exclude the given servers. ' +
              'Both multiple values (-x server1 -x server2) or a single comma' +
              ' separated list (-x server1,server2) of service names to be ' +
              'excluded are supported.'
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
