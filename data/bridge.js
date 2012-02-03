self.port.on('uiData', function(msg) {
  /*
  var event = document.createEvent('MessageEvent');
  event.initMessageEvent('uiData', false, false,
                         JSON.stringify(msg),
                         '*', null, null, null);
  window.dispatchEvent(event);
  */
  unsafeWindow.receiveUiData(msg);
});

unsafeWindow.sendUiRequest = function(msg) {
  self.port.emit('uiReq', msg);
};

/*
window.addEventListener('message', function (event) {
  if (event.data.type !== 'frobbed')
    self.port.emit('uiReq', event.data);
}, false);
*/
