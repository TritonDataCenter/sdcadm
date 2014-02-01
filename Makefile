#
# Copyright (c) 2014, Joyent, Inc. All rights reserved.
#
# Makefile for sdcadm
#

#
# Vars, Tools, Files, Flags
#
NAME		:= sdcadm
DOC_FILES	 = index.restdown
JS_FILES	:= bin/sdcadm \
	$(shell find lib -name '*.js' | grep -v '/tmp/') \
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE	 = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS	 = -f tools/jsstyle.conf
NODEUNIT	:= ./node_modules/.bin/nodeunit
CLEAN_FILES += ./node_modules ./sdcadm-*.sh ./build/shar-image

# XXX TODO: get new sdcnode for this v0.10.25
NODE_PREBUILT_VERSION=v0.10.21
ifeq ($(shell uname -s),SunOS)
	NODE_PREBUILT_TAG=gz
	NODE_PREBUILT_IMAGE=01b2c898-945f-11e1-a523-af1afbe22822
endif


include ./tools/mk/Makefile.defs
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.defs
else
	include ./tools/mk/Makefile.node.defs
endif

RELEASE_TARBALL	:= $(NAME)-pkg-$(STAMP).tar.bz2
RELSTAGEDIR       := /tmp/$(STAMP)



#
# Targets
#
.PHONY: all
all: | $(NODEUNIT)
	$(NPM) install

$(NODEUNIT): | $(NPM_EXEC)
	$(NPM) install

.PHONY: test
test: | $(NODEUNIT)
	./test/runtests

.PHONY: release
release: all
	@echo "Building $(RELEASE_TARBALL)"
	XXX
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)
	mkdir -p $(RELSTAGEDIR)/site
	touch $(RELSTAGEDIR)/site/.do-not-delete-me
	mkdir -p $(RELSTAGEDIR)/root
	cp -r \
		$(TOP)/bin \
		$(TOP)/main.js \
		$(TOP)/lib \
		$(TOP)/etc \
		$(TOP)/node_modules \
		$(TOP)/package.json \
		$(TOP)/sapi_manifests \
		$(TOP)/smf \
		$(TOP)/test \
		$(RELSTAGEDIR)/root/opt/smartdc/$(NAME)
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/tools
	cp -r \
		$(TOP)/tools/seed-packages \
		$(TOP)/tools/prepare-image \
		$(TOP)/tools/get-image-dataset-guid.sh \
		$(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/tools/
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/boot
	cp -R $(TOP)/deps/sdc-scripts/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	cp -R $(TOP)/boot/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/build
	cp -r \
		$(TOP)/build/node \
		$(TOP)/build/public-docs \
		$(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/build
	(cd $(RELSTAGEDIR) && $(TAR) -jcf $(TOP)/$(RELEASE_TARBALL) root site)
	@rm -rf $(RELSTAGEDIR)

#.PHONY: publish
#publish: release
#	@if [[ -z "$(BITS_DIR)" ]]; then \
#		@echo "error: 'BITS_DIR' must be set for 'publish' target"; \
#		exit 1; \
#	fi
#	mkdir -p $(BITS_DIR)/$(NAME)
#	cp $(TOP)/$(RELEASE_TARBALL) $(BITS_DIR)/$(NAME)/$(RELEASE_TARBALL)

.PHONY: shar
shar:
	./tools/mk-shar

#XXX
.PHONY: publish
publish:
	ssh $(PUBLISH_HOST) mkdir -p $(PUBLISH_RDIR)
	scp `ls centos-guest-tools-for-smartos-$(VERSION)-*.sh | tail -1` \
		$(PUBLISH_LOC)/centos-guest-tools-for-smartos-$(VERSION).sh

.PHONY: dumpvar
dumpvar:
	@if [[ -z "$(VAR)" ]]; then \
		echo "error: set 'VAR' to dump a var"; \
		exit 1; \
	fi
	@echo "$(VAR) is '$($(VAR))'"


include ./tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.targ
else
	include ./tools/mk/Makefile.node.targ
endif
include ./tools/mk/Makefile.targ

sdc-scripts: deps/sdc-scripts/.git
