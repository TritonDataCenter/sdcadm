#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

#
# Makefile for sdcadm
#

#
# Vars, Tools, Files, Flags
#
NAME		:= sdcadm
DOC_FILES	 = index.md config.md
EXTRA_DOC_DEPS += deps/restdown-brand-remora/.git
RESTDOWN_FLAGS   = --brand-dir=deps/restdown-brand-remora
JS_FILES	:= $(shell find lib test -name '*.js' | grep -v '/tmp/')
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE	 = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS	 = -f tools/jsstyle.conf
CLEAN_FILES += ./node_modules ./build/sdcadm-*.sh ./build/sdcadm-*.imgmanifest ./build/shar-image ./man/man1/sdcadm.1


NODE_PREBUILT_VERSION=v0.10.26
ifeq ($(shell uname -s),SunOS)
	NODE_PREBUILT_TAG=gz
	# sdc-smartos/1.6.3
	NODE_PREBUILT_IMAGE=fd2cc906-8938-11e3-beab-4359c665ac99
endif


include ./tools/mk/Makefile.defs
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.defs
else
	include ./tools/mk/Makefile.node.defs
endif


#
# Targets
#
.PHONY: all
all: | $(NPM_EXEC)
	MAKE_OVERRIDES='CTFCONVERT=/bin/true CTFMERGE=/bin/true' $(NPM) install
	./node_modules/.bin/kthxbai || true # work around trentm/node-kthxbai#1
	./node_modules/.bin/kthxbai
	rm -rf ./node_modules/.bin/kthxbai ./node_modules/kthxbai

.PHONY: shar
shar:
	./tools/mk-shar -o $(TOP)/build -s $(STAMP)

.PHONY: test
test:
	./test/runtests

.PHONY: release
release: all man shar

.PHONY: publish
publish: release
	@if [[ -z "$(BITS_DIR)" ]]; then \
		@echo "error: 'BITS_DIR' must be set for 'publish' target"; \
		exit 1; \
	fi
	mkdir -p $(BITS_DIR)/$(NAME)
	cp \
		$(TOP)/build/sdcadm-$(STAMP).sh \
		$(TOP)/build/sdcadm-$(STAMP).imgmanifest \
		$(BITS_DIR)/$(NAME)/

.PHONY: dumpvar
dumpvar:
	@if [[ -z "$(VAR)" ]]; then \
		echo "error: set 'VAR' to dump a var"; \
		exit 1; \
	fi
	@echo "$(VAR) is '$($(VAR))'"

# Ensure all version-carrying files have the same version.
.PHONY: check-version
check-version:
	@echo version is: $(shell cat package.json | json version)
	[[ `cat package.json | json version` == `grep '^## ' CHANGES.md | head -1 | awk '{print $$2}'` ]]
	@echo Version check ok.

check:: check-version


.PHONY: man
man: man/man1/sdcadm.1.ronn
	rm -f man/man1/sdcadm.1
	./node_modules/.bin/marked-man --input man/man1/sdcadm.1.ronn \
		--date `git log -1 --pretty=format:%cd --date=short` \
		--output man/man1/sdcadm.1
	chmod 444 man/man1/sdcadm.1


include ./tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.targ
else
	include ./tools/mk/Makefile.node.targ
endif
include ./tools/mk/Makefile.targ
