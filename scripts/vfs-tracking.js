(function () {
  'use strict';

  var form = document.getElementById('vfs-track-form');
  if (!form) return;

  var referenceInput = document.getElementById('vfs-reference');
  var lastNameInput = document.getElementById('vfs-last-name');
  var status = document.getElementById('vfs-track-status');

  form.addEventListener('submit', function (event) {
    event.preventDefault();

    var reference = referenceInput.value.trim();
    var lastName = lastNameInput.value.trim();
    if (!reference || !lastName) {
      if (status) {
        status.textContent = "Enter both the VFS reference number and the applicant's last name.";
      }
      (reference ? lastNameInput : referenceInput).focus();
      return;
    }

    var url = 'https://visa.vfsglobal.com/ind/en/irl/track-application' +
      '?reference=' + encodeURIComponent(reference) +
      '&lastName=' + encodeURIComponent(lastName);
    window.open(url, '_blank', 'noopener,noreferrer');
    if (status) status.textContent = 'Opening VFS Global\u2026';
  });
})();
