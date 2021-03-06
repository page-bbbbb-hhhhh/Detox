const _ = require('lodash');
const AsyncWebSocket = require('./AsyncWebSocket');
const actions = require('./actions/actions');
const argparse = require('../utils/argparse');
const log = require('../utils/logger').child({ __filename });
const { asError, removeInternalStackEntries } = require('../utils/errorUtils');

class Client {
  constructor(config) {
    this.isConnected = false;
    this.configuration = config;
    this.ws = new AsyncWebSocket(config.server);
    this.slowInvocationStatusHandler = null;
    this.slowInvocationTimeout = argparse.getArgValue('debug-synchronization');
    this.successfulTestRun = true; // flag for cleanup
    this.pandingAppCrash;

    this.setActionListener(new actions.AppWillTerminateWithError(), (response) => {
      this.pandingAppCrash = response.params.errorDetails;
      this.ws.rejectAll(this.pandingAppCrash);
    });
  }

  async connect() {
    await this.ws.open();
    await this.sendAction(new actions.Login(this.configuration.sessionId));
  }

  async reloadReactNative() {
    await this.sendAction(new actions.ReloadReactNative());
  }

  async waitUntilReady() {
    await this.sendAction(new actions.Ready());
    this.isConnected = true;
  }

  async waitForBackground() {
    await this.sendAction(new actions.WaitForBackground());
  }

  async waitForActive() {
    await this.sendAction(new actions.WaitForActive());
  }

  async cleanup() {
    clearTimeout(this.slowInvocationStatusHandler);
    if (this.isConnected && !this.pandingAppCrash) {
      if(this.ws.isOpen()) {
        await this.sendAction(new actions.Cleanup(this.successfulTestRun));
      }
      this.isConnected = false;
    }

    if (this.ws.isOpen()) {
      await this.ws.close();
    }
  }

  async currentStatus() {
    await this.sendAction(new actions.CurrentStatus());
  }

  async setSyncSettings(params) {
    await this.sendAction(new actions.SetSyncSettings(params));
  }

  async shake() {
    await this.sendAction(new actions.Shake());
  }

  async setOrientation(orientation) {
    await this.sendAction(new actions.SetOrientation(orientation));
  }

  async startInstrumentsRecording({ recordingPath, samplingInterval }) {
    await this.sendAction(new actions.SetInstrumentsRecordingState({
      recordingPath, samplingInterval
    }));
  }

  async stopInstrumentsRecording() {
    await this.sendAction(new actions.SetInstrumentsRecordingState());
  }

  async deliverPayload(params) {
    await this.sendAction(new actions.DeliverPayload(params));
  }

  async execute(invocation) {
    if (typeof invocation === 'function') {
      invocation = invocation();
    }

    if (this.slowInvocationTimeout) {
      this.slowInvocationStatusHandler = this.slowInvocationStatus();
    }

    try {
      return await this.sendAction(new actions.Invoke(invocation));
    } catch (err) {
      this.successfulTestRun = false;
      throw removeInternalStackEntries(asError(err));
    } finally {
      clearTimeout(this.slowInvocationStatusHandler);
    }
  }

  getPendingCrashAndReset() {
    const crash = this.pandingAppCrash;
    this.pandingAppCrash = undefined;

    return crash;
  }

  setNonresponsivenessListener(clientCallback) {
    this.setActionListener(new actions.AppNonresponsive(), (event) => clientCallback(event.params));
  }

  setActionListener(action, clientCallback) {
    this.ws.setEventCallback(action.messageId, (response) => {
      const parsedResponse = JSON.parse(response);
      action.handle(parsedResponse);

      /* istanbul ignore next */
      if (clientCallback) {
        clientCallback(parsedResponse);
      }
    });
  }

  async sendAction(action) {
    const response = await this.ws.send(action, action.messageId);
    const parsedResponse = JSON.parse(response);
    return await action.handle(parsedResponse);
  }

  slowInvocationStatus() {
    return setTimeout(async () => {
      if (this.ws.isOpen()) {
        const status = await this.currentStatus();
        this.slowInvocationStatusHandler = this.slowInvocationStatus();
      }
    }, this.slowInvocationTimeout);
  }

  dumpPendingRequests({testName} = {}) {
    const messages = _.values(this.ws.inFlightPromises)
      .map(p => p.message)
      .filter(m => m.type !== 'currentStatus');

    if (_.isEmpty(messages)) {
      return;
    }

    let dump = 'App has not responded to the network requests below:';
    for (const msg of messages) {
      dump += `\n  (id = ${msg.messageId}) ${msg.type}: ${JSON.stringify(msg.params)}`;
    }

    const notice = testName
      ? `That might be the reason why the test "${testName}" has timed out.`
      : `Unresponded network requests might result in timeout errors in Detox tests.`;

    dump += `\n\n${notice}\n`;

    log.warn({ event: 'PENDING_REQUESTS'}, dump);
    this.ws.resetInFlightPromises();
  }
}

module.exports = Client;
