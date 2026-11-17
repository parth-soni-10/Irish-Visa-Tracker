(function() {
  var forms = document.querySelectorAll('form[data-async-form]');
  if (!forms.length) return;

  function formBody(form) {
    var body = new URLSearchParams();
    new FormData(form).forEach(function(value, key) {
      body.append(key, value);
    });
    return body.toString();
  }

  function setStatus(form, message, kind) {
    var status = form.querySelector('.contact-form-status');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('is-success', kind === 'success');
    status.classList.toggle('is-error', kind === 'error');
  }

  function validateTimeline(form) {
    var applied = form.elements.applied.value;
    var decided = form.elements.decided.value;
    var today = new Date().toISOString().slice(0, 10);
    if (!applied || !decided) {
      setStatus(form, 'Please fill in both dates.', 'error');
      return false;
    }
    if (applied < '2020-01-01' || applied > decided || decided > today) {
      setStatus(form, 'Those dates don\u2019t look right - applied must come first and decided can\u2019t be in the future.', 'error');
      return false;
    }
    return true;
  }

  forms.forEach(function(form) {
    form.addEventListener('submit', function(event) {
      event.preventDefault();
      if (form.dataset.submitting === '1') return;
      if (form.id === 'timeline-form' && !validateTimeline(form)) return;

      var button = form.querySelector('button[type="submit"]');
      var original = button ? button.textContent : '';
      form.dataset.submitting = '1';
      form.setAttribute('aria-busy', 'true');
      if (button) {
        button.disabled = true;
        button.textContent = 'Sending\u2026';
      }
      setStatus(form, 'Sending\u2026');

      fetch(form.getAttribute('action') || window.location.pathname, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'Accept': 'application/json'
        },
        body: formBody(form)
      }).then(function(response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        form.reset();
        setStatus(
          form,
          form.id === 'timeline-form'
            ? 'Thanks - your timeline has been shared. It appears after the nightly sync.'
            : 'Thanks - your feedback has been received.',
          'success'
        );
      }).catch(function() {
        setStatus(form, 'Could not submit. Please try again, or email instead.', 'error');
      }).finally(function() {
        form.dataset.submitting = '0';
        form.removeAttribute('aria-busy');
        if (button) {
          button.disabled = false;
          button.textContent = original;
        }
      });
    });
  });
})();
