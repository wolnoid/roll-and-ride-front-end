import { useState, useContext } from 'react';
import { Link, useNavigate } from 'react-router';
import { signIn } from '../../services/authService';
import { UserContext } from '../../contexts/UserContext';
import styles from './SignInForm.module.css';

const SignInForm = ({ embedded = false, onCancel, onSwitchToSignUp, onSuccess }) => {
  const navigate = useNavigate();
  const { setUser } = useContext(UserContext);
  const [message, setMessage] = useState('');
  const [formData, setFormData] = useState({
    username: '',
    password: '',
  });
  const { username, password } = formData;

  const handleChange = (evt) => {
    setMessage('');
    setFormData({ ...formData, [evt.target.name]: evt.target.value });
  };

  const handleSubmit = async (evt) => {
    evt.preventDefault();
    try {
      const signedInUser = await signIn(formData);
      setUser(signedInUser);
      onSuccess?.(signedInUser);
      navigate('/');
    } catch (err) {
      setMessage(err.message);
    }
  };

  const isFormInvalid = () => {
    return !(username && password);
  };

  const handleCancel = () => {
    if (embedded) {
      onCancel?.();
      return;
    }
    navigate('/');
  };

  return (
    <main className={`${styles.page} ${embedded ? styles.embeddedPage : ''}`}>
      <section className={styles.formPane}>
        <form
          className={`${styles.form} ${embedded ? styles.embeddedForm : ''}`}
          autoComplete='off'
          onSubmit={handleSubmit}
        >
          <h1>Sign In</h1>
          <p className={styles.message}>{message || 'Enter your account details to continue.'}</p>
          <div className={styles.field}>
            <label htmlFor='username'>Username</label>
            <input
              className={styles.input}
              type='text'
              autoComplete='off'
              id='username'
              value={formData.username}
              name='username'
              onChange={handleChange}
              required
            />
          </div>
          <div className={styles.field}>
            <label htmlFor='password'>Password</label>
            <input
              className={styles.input}
              type='password'
              autoComplete='off'
              id='password'
              value={formData.password}
              name='password'
              onChange={handleChange}
              required
            />
          </div>
          <div className={styles.actions}>
            <button className={styles.primaryButton} type='submit' disabled={isFormInvalid()}>
              Sign In
            </button>
            <button
              className={styles.secondaryButton}
              type='button'
              onClick={handleCancel}
            >
              Cancel
            </button>
          </div>
          {embedded ? (
            <p className={styles.authSwitch}>
              Not a user?{' '}
              <button type='button' className={styles.inlineLink} onClick={onSwitchToSignUp}>
                Sign up
              </button>
            </p>
          ) : (
            <p className={styles.authSwitch}>
              <Link to='/sign-up'>Not a user? Sign up</Link>
            </p>
          )}
        </form>
      </section>
    </main>
  );
};

export default SignInForm;
